// Snowflake Cortex client (OpenAI chat-completions format) plus the template fallback.
// Credentials come only from environment variables and never leave the server.

import { LATE_START_MS } from './validate.js';

export const CORTEX_TIMEOUT_MS = 10_000;
export const CORTEX_MAX_TOKENS = 120;
// Sent by default, dropped (with one retry) if Cortex rejects them for a model.
const OPTIONAL_PARAMS = ['temperature'];
const TIMING_TOLERANCE_MS = 120; // same window the browser uses for "on time"
const MAX_DRILL_CHARS = 400;

export class CortexError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CortexError';
    this.status = status;
  }
}

/** Returns the Cortex settings from env, or null if anything is missing or malformed. */
export function cortexConfig(env = process.env) {
  // Snowflake hostnames use hyphens where account identifiers use underscores.
  const account = env.SNOWFLAKE_ACCOUNT?.trim().toLowerCase().replace(/_/g, '-');
  const pat = env.SNOWFLAKE_PAT?.trim();
  const model = env.SNOWFLAKE_MODEL?.trim();
  if (!account || !pat || !model) return null;
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(account)) return null; // keep the URL host well-formed
  return {
    url: `https://${account}.snowflakecomputing.com/api/v2/cortex/v1/chat/completions`,
    pat,
    model,
  };
}

const SYSTEM_PROMPT = [
  'You are a concise music practice coach for a student practising a single melody line.',
  'Reply with exactly ONE practice drill of at most two sentences.',
  'The drill must be about the bar you are given; do not pick a different bar.',
  'Include a concrete tempo (for example half tempo), a number of repetitions, and one thing to focus on, based on the measured errors.',
  'No greeting, no lists, no markdown.',
].join(' ');

export function buildMessages({ piece, target }) {
  const offsets = target.timingOffsetsMs.map((x) => Math.round(x));
  const user = [
    `Piece: ${piece}`,
    `Target bar: ${target.label}`,
    `Missed notes in this bar: ${target.missedNotes}`,
    `Timing offsets of the notes played in this bar (ms; negative = early, positive = late): ${offsets.length ? offsets.join(', ') : 'none measured'}`,
    `Mean absolute timing offset: ${Math.round(target.meanAbsOffsetMs)} ms (on time means within ±${TIMING_TOLERANCE_MS} ms)`,
    `Notes that came in more than ${LATE_START_MS / 1000} s late (a late start after the count-in, not a rhythm error): ${target.lateStarts ?? 0}`,
    `Write one drill for bar ${target.label}.`,
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Trims model output to plain text of at most two sentences. */
export function cleanDrill(content) {
  let text = Array.isArray(content)
    ? content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join(' ')
    : String(content ?? '');
  text = text.replace(/[*_#`>]+/g, '').replace(/^\s*(drill|answer)\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
  const sentences = text.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [];
  text = sentences.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
  if (text.length > MAX_DRILL_CHARS) text = `${text.slice(0, MAX_DRILL_CHARS - 1).trimEnd()}…`;
  return text;
}

function errorMessage(bodyText) {
  try {
    const body = JSON.parse(bodyText);
    return String(body.message ?? body.error?.message ?? body.error ?? bodyText).slice(0, 500);
  } catch {
    return String(bodyText).slice(0, 500);
  }
}

/**
 * Asks Cortex for one drill. Throws CortexError on HTTP errors, timeouts, or empty output.
 */
export async function requestCortexDrill({ config, piece, target, fetchImpl = fetch, timeoutMs = CORTEX_TIMEOUT_MS, log = console }) {
  // One deadline for the whole call, including the single retry below.
  const signal = AbortSignal.timeout(timeoutMs);
  const body = {
    model: config.model,
    messages: buildMessages({ piece, target }),
    max_completion_tokens: CORTEX_MAX_TOKENS, // Cortex rejects the deprecated max_tokens
    temperature: 0.3,
  };

  let response = await post(body);
  if (response.status === 400) {
    const message = errorMessage(await response.text().catch(() => ''));
    // Optional sampling parameters some Cortex models refuse: retry once without them.
    const rejected = OPTIONAL_PARAMS.filter((name) => name in body && new RegExp(`\\b${name}\\b`, 'i').test(message));
    if (!rejected.length) throw new CortexError(400, message || 'bad request');
    log.warn(`[drill] Cortex rejected ${rejected.join(', ')} (${message}); retrying without it`);
    for (const name of rejected) delete body[name];
    response = await post(body);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new CortexError(response.status, errorMessage(bodyText) || response.statusText || 'request failed');
  }

  async function post(payload) {
    try {
      return await fetchImpl(config.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.pat}`,
          'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new CortexError(null, `timed out after ${timeoutMs} ms`);
      }
      throw new CortexError(null, `network error: ${error?.message ?? error}`);
    }
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new CortexError(response.status, 'response was not valid JSON');
  }
  const drill = cleanDrill(data?.choices?.[0]?.message?.content);
  if (!drill) throw new CortexError(response.status, 'response contained no drill text');
  return drill;
}

/** Template drill used when Cortex is not configured or fails. */
export function fallbackDrill(target) {
  const label = target.label;
  const n = /^\d+$/.test(label) ? Number(label) : null;
  const first = n !== null && n > 1
    ? `Start at bar ${n - 1} and play through bar ${label} at half tempo, 3 times, keeping the beat steady.`
    : `Play bar ${label} at half tempo, 3 times, keeping the beat steady.`;

  let second = '';
  if (target.missedNotes > 0) {
    second = ` Make sure every note sounds clearly: ${target.missedNotes} ${target.missedNotes === 1 ? 'note was' : 'notes were'} missed there.`;
  } else if (target.meanAbsOffsetMs > TIMING_TOLERANCE_MS) {
    const direction = target.meanOffsetMs >= 0 ? 'late' : 'early';
    second = ` Your notes there were about ${Math.round(target.meanAbsOffsetMs)} ms ${direction} on average, so lock each one to the beat.`;
  } else if ((target.lateStarts ?? 0) > 0) {
    second = ` Come in on the downbeat straight after the four count-in clicks: ${target.lateStarts === 1 ? 'one note' : `${target.lateStarts} notes`} started more than ${LATE_START_MS / 1000} seconds late.`;
  }
  return first + second;
}
