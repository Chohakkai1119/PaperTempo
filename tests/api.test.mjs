// Backend tests: target-bar picker, validation, rate limiter, Cortex client and /api routes.
// fetch is always mocked: these tests never touch the network or real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickTargetBar } from '../lib/target-bar.js';
import { validateDrillRequest, LIMITS } from '../lib/validate.js';
import { createRateLimiter, clientIp } from '../lib/rate-limit.js';
import { cortexConfig, cleanDrill, fallbackDrill, requestCortexDrill } from '../lib/cortex.js';
import { createDrillHandler } from '../lib/drill.js';
import { GET as health } from '../api/health.js';

const ENV = { SNOWFLAKE_ACCOUNT: 'myorg-myaccount', SNOWFLAKE_PAT: 'test-token-not-real', SNOWFLAKE_MODEL: 'claude-haiku-4-5' };
const BODY = {
  piece: 'Morning Lines',
  bars: [
    { bar: '9', missedNotes: 0, timingOffsetsMs: [5, -12, 260] },
    { bar: '10', missedNotes: 1, timingOffsetsMs: [401, 269, 10] },
  ],
};

function quietLog() {
  const lines = [];
  return { lines, warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]) };
}

function post(body, { ip = '203.0.113.7', raw, type = 'application/json' } = {}) {
  return new Request('http://localhost/api/drill', {
    method: 'POST',
    headers: { 'content-type': type, 'x-real-ip': ip },
    body: raw ?? JSON.stringify(body),
  });
}

function completion(content) {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- target-bar picker

test('picker: worst mean absolute timing offset wins', () => {
  const t = pickTargetBar([
    { bar: '1', missedNotes: 3, timingOffsetsMs: [10, -10] },
    { bar: '2', missedNotes: 0, timingOffsetsMs: [-300, 100] },
    { bar: '3', missedNotes: 0, timingOffsetsMs: [150, 150] },
  ]);
  assert.equal(t.bar, '2');
  assert.equal(t.meanAbsOffsetMs, 200);
  assert.equal(t.meanOffsetMs, -100);
});

test('picker: ties broken by most missed notes, then earliest bar', () => {
  assert.equal(pickTargetBar([
    { bar: '4', missedNotes: 1, timingOffsetsMs: [100] },
    { bar: '5', missedNotes: 2, timingOffsetsMs: [-100] },
  ]).bar, '5');
  assert.equal(pickTargetBar([
    { bar: '6', missedNotes: 2, timingOffsetsMs: [] },
    { bar: '7', missedNotes: 2, timingOffsetsMs: [] },
  ]).bar, '6');
});

test('picker: bars without offsets count as 0 ms, so missed notes decide', () => {
  assert.equal(pickTargetBar([
    { bar: '1', missedNotes: 0, timingOffsetsMs: [] },
    { bar: '2', missedNotes: 4, timingOffsetsMs: [] },
  ]).bar, '2');
});

// ---- validation

test('validation accepts a good body and drops unknown fields', () => {
  const r = validateDrillRequest({ ...BODY, audio: 'nope', extras: 21, bars: [{ ...BODY.bars[0], extra: 1 }, { bar: 12, missedNotes: 0, timingOffsetsMs: [] }] });
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.value), ['piece', 'bars']);
  assert.deepEqual(r.value.bars[0], { bar: '9', label: '9', missedNotes: 0, timingOffsetsMs: [5, -12, 260], lateStarts: 0 });
  assert.equal(r.value.bars[1].label, '12');
});

test('validation: missing or empty optional fields are treated as empty', () => {
  const r = validateDrillRequest({ bars: [{ bar: 3 }, { bar: '4', missedNotes: null, timingOffsetsMs: null }, { bar: '5', missedNotes: 2, timingOffsetsMs: [] }] });
  assert.ok(r.ok, r.error);
  assert.equal(r.value.piece, 'Untitled score');
  assert.deepEqual(r.value.bars.map((b) => [b.label, b.missedNotes, b.timingOffsetsMs.length, b.lateStarts]), [['3', 0, 0, 0], ['4', 0, 0, 0], ['5', 2, 0, 0]]);
});

test('validation: offsets beyond ±2000 ms count as late starts, not timing errors', () => {
  const r = validateDrillRequest({ piece: 'p', bars: [{ bar: '1', missedNotes: 0, timingOffsetsMs: [19842, 1999, -2001, 40, 2000] }] });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.value.bars[0].timingOffsetsMs, [1999, 40, 2000]);
  assert.equal(r.value.bars[0].lateStarts, 2);
});

test('validation: real-world quirks are normalised instead of rejected', () => {
  const r = validateDrillRequest({
    piece: `  ${'Very long title '.repeat(20)}\u0007`,
    bars: [
      { bar: 'X1', missedNotes: 1.6, timingOffsetsMs: [10] },
      { bar: 'X1', missedNotes: 1, timingOffsetsMs: [30] }, // duplicate label: merged
      { bar: 0, missedNotes: -3 }, // pickup bar 0, negative count clamped
      { bar: '12a(repeat)', missedNotes: 0, timingOffsetsMs: new Array(LIMITS.maxOffsetsPerBar + 10).fill(1) },
    ],
  });
  assert.ok(r.ok, r.error);
  assert.ok(r.value.piece.length <= LIMITS.maxPieceLength);
  assert.deepEqual(r.value.bars[0], { bar: 'X1', label: 'X1', missedNotes: 3, timingOffsetsMs: [10, 30], lateStarts: 0 });
  assert.equal(r.value.bars[1].missedNotes, 0);
  assert.equal(r.value.bars[2].label, '12a(repeat)');
  assert.equal(r.value.bars[2].timingOffsetsMs.length, LIMITS.maxOffsetsPerBar);
});

test('validation rejects only malformed requests', () => {
  const bad = [
    null,
    [],
    'bars',
    { piece: 'p' },
    { piece: 'p', bars: [] },
    { piece: 'p', bars: {} },
    { piece: 42, bars: BODY.bars },
    { piece: 'p', bars: ['9'] },
    { piece: 'p', bars: [{ missedNotes: 1 }] },
    { piece: 'p', bars: [{ bar: true }] },
    { piece: 'p', bars: [{ bar: '   ' }] },
    { piece: 'p', bars: [{ bar: '9', missedNotes: '2' }] },
    { piece: 'p', bars: [{ bar: '9', timingOffsetsMs: 'fast' }] },
    { piece: 'p', bars: [{ bar: '9', timingOffsetsMs: ['5'] }] },
    { piece: 'p', bars: Array.from({ length: LIMITS.maxBars + 1 }, (_, i) => ({ bar: i + 1 })) },
  ];
  for (const body of bad) {
    const r = validateDrillRequest(body);
    assert.equal(r.ok, false, JSON.stringify(body)?.slice(0, 80));
    assert.equal(typeof r.error, 'string');
  }
});

// ---- rate limiter

test('rate limiter: 5 per minute per key, then blocked until the window passes', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 5, windowMs: 60_000, now: () => t });
  for (let i = 0; i < 5; i++) assert.equal(rl.check('a').allowed, true);
  const blocked = rl.check('a');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSec, 60);
  assert.equal(rl.check('b').allowed, true); // other IPs unaffected
  t = 30_000;
  assert.equal(rl.check('a').retryAfterSec, 30);
  t = 60_001;
  assert.equal(rl.check('a').allowed, true);
});

test('clientIp prefers x-real-ip, then the first x-forwarded-for entry', () => {
  assert.equal(clientIp(new Request('http://x', { headers: { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' } })), '1.2.3.4');
  assert.equal(clientIp(new Request('http://x', { headers: { 'x-forwarded-for': '5.6.7.8, 10.0.0.1' } })), '5.6.7.8');
  assert.equal(clientIp(new Request('http://x')), 'unknown');
});

// ---- Cortex client

test('cortexConfig needs all three env vars and builds the Snowflake URL', () => {
  assert.equal(cortexConfig({}), null);
  assert.equal(cortexConfig({ ...ENV, SNOWFLAKE_PAT: '' }), null);
  assert.equal(cortexConfig({ ...ENV, SNOWFLAKE_ACCOUNT: 'evil.com/x?' }), null);
  assert.equal(cortexConfig(ENV).url, 'https://myorg-myaccount.snowflakecomputing.com/api/v2/cortex/v1/chat/completions');
  assert.equal(cortexConfig({ ...ENV, SNOWFLAKE_ACCOUNT: 'MyOrg_MyAccount' }).url, 'https://myorg-myaccount.snowflakecomputing.com/api/v2/cortex/v1/chat/completions');
});

test('Cortex request: headers, model, low max_completion_tokens, target bar in the prompt', async () => {
  let call;
  const fetchImpl = async (url, init) => {
    call = { url, init, body: JSON.parse(init.body) };
    return completion('**Drill:** Play bar 10 at half tempo 3 times. Count the beat aloud. Then speed up.');
  };
  const target = pickTargetBar(validateDrillRequest(BODY).value.bars);
  const drill = await requestCortexDrill({ config: cortexConfig(ENV), piece: 'Morning Lines', target, fetchImpl });
  assert.equal(drill, 'Play bar 10 at half tempo 3 times. Count the beat aloud.'); // markdown stripped, max 2 sentences
  assert.equal(call.url, 'https://myorg-myaccount.snowflakecomputing.com/api/v2/cortex/v1/chat/completions');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer test-token-not-real');
  assert.equal(call.init.headers['X-Snowflake-Authorization-Token-Type'], 'PROGRAMMATIC_ACCESS_TOKEN');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.equal(call.body.model, 'claude-haiku-4-5');
  assert.equal(call.body.max_completion_tokens, 120);
  assert.equal('max_tokens' in call.body, false); // deprecated: Cortex answers 400
  assert.equal(call.body.temperature, 0.3);
  assert.equal(call.body.messages[0].role, 'system');
  assert.match(call.body.messages[0].content, /concise music practice coach/);
  assert.match(call.body.messages[1].content, /Target bar: 10\n/);
  assert.match(call.body.messages[1].content, /401, 269, 10/);
});

test('Cortex rejects temperature → one retry without it succeeds', async () => {
  const bodies = [];
  const log = quietLog();
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if ('temperature' in body) return new Response(JSON.stringify({ message: 'temperature is not supported for this model' }), { status: 400 });
    return completion('Play bar 10 at half tempo three times.');
  };
  const handler = createDrillHandler({ env: ENV, fetchImpl, log });
  const data = await (await handler(post(BODY))).json();
  assert.equal(data.source, 'cortex');
  assert.equal(bodies.length, 2);
  assert.equal('temperature' in bodies[1], false);
  assert.equal(bodies[1].max_completion_tokens, 120);
  assert.match(log.lines.find(([level]) => level === 'warn')[1], /rejected temperature/);
});

test('Cortex 400 about anything else → no retry, fallback with the message logged', async () => {
  let calls = 0;
  const log = quietLog();
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: 'max_tokens is deprecated in favor of max_completion_tokens' }), { status: 400 });
  };
  const handler = createDrillHandler({ env: ENV, fetchImpl, log });
  const data = await (await handler(post(BODY))).json();
  assert.equal(data.source, 'fallback');
  assert.equal(calls, 1);
  assert.match(log.lines.at(-1)[1], /status=400 message=max_tokens is deprecated in favor of max_completion_tokens/);
});

test('cleanDrill handles content-part arrays and empty output', () => {
  assert.equal(cleanDrill([{ type: 'text', text: 'Play bar 3 slowly.' }]), 'Play bar 3 slowly.');
  assert.equal(cleanDrill(''), '');
  assert.equal(cleanDrill(undefined), '');
});

test('fallback drill templates', () => {
  assert.equal(
    fallbackDrill({ label: '10', missedNotes: 0, meanAbsOffsetMs: 50, meanOffsetMs: 50 }),
    'Start at bar 9 and play through bar 10 at half tempo, 3 times, keeping the beat steady.',
  );
  assert.match(fallbackDrill({ label: '1', missedNotes: 2, meanAbsOffsetMs: 0, meanOffsetMs: 0 }), /^Play bar 1 at half tempo, 3 times.*2 notes were missed/);
  assert.match(fallbackDrill({ label: '4', missedNotes: 0, meanAbsOffsetMs: 300, meanOffsetMs: 300 }), /about 300 ms late/);
});

// ---- /api/drill handler

test('drill: missing env vars → fallback without calling fetch', async () => {
  let called = false;
  const log = quietLog();
  const handler = createDrillHandler({ env: {}, fetchImpl: async () => { called = true; }, log });
  const res = await handler(post(BODY));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, {
    targetBar: '10',
    drill: 'Start at bar 9 and play through bar 10 at half tempo, 3 times, keeping the beat steady. Make sure every note sounds clearly: 1 note was missed there.',
    source: 'fallback',
  });
  assert.equal(called, false);
  assert.equal(log.lines[0][0], 'warn');
});

test('drill: real messy take (3 of 4 matched, 21 extras, ~19.8 s late, 0% on time) → 200 with a drill', async () => {
  // Exact body the browser sent for that take (extras are not part of the payload).
  const take = { piece: 'Morning Lines', bars: [{ bar: '1', missedNotes: 0, timingOffsetsMs: [19842, 19838, 19833] }] };
  const log = quietLog();
  const handler = createDrillHandler({ env: {}, log });
  const res = await handler(post(take));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.targetBar, '1');
  assert.equal(data.source, 'fallback');
  assert.equal(
    data.drill,
    'Play bar 1 at half tempo, 3 times, keeping the beat steady. Come in on the downbeat straight after the four count-in clicks: 3 notes started more than 2 seconds late.',
  );
  assert.ok(!log.lines.some(([, line]) => line.includes('rejected')));

  // The same take with Cortex configured: the prompt reports a late start, not a 19 s timing error.
  let prompt;
  const cortex = createDrillHandler({
    env: ENV,
    log: quietLog(),
    fetchImpl: async (url, init) => {
      prompt = JSON.parse(init.body).messages[1].content;
      return completion('Count in, then start bar 1 on the downbeat at half tempo three times.');
    },
  });
  const viaCortex = await (await cortex(post(take))).json();
  assert.equal(viaCortex.source, 'cortex');
  assert.match(prompt, /Mean absolute timing offset: 0 ms/);
  assert.match(prompt, /more than 2 s late \(a late start after the count-in, not a rhythm error\): 3/);
  assert.match(prompt, /none measured/);
});

test('drill: rejected requests are logged with the reason and body', async () => {
  const log = quietLog();
  const handler = createDrillHandler({ env: {}, log });
  assert.equal((await handler(post({ piece: 'p', bars: [] }))).status, 400);
  assert.match(log.lines.at(-1)[1], /rejected 400: "bars" must contain at least one bar\. body=\{"piece":"p","bars":\[\]\}/);
});

test('drill: Cortex success → source "cortex", target bar chosen by us', async () => {
  const handler = createDrillHandler({ env: ENV, fetchImpl: async () => completion('Play bar 3 three times.'), log: quietLog() });
  const data = await (await handler(post(BODY))).json();
  assert.equal(data.source, 'cortex');
  assert.equal(data.targetBar, '10'); // even though the model mentioned bar 3
  assert.equal(data.drill, 'Play bar 3 three times.');
});

test('drill: Cortex HTTP error → fallback, logs status and message but never the token', async () => {
  const log = quietLog();
  const fetchImpl = async () => new Response(JSON.stringify({ message: 'Invalid OAuth access token test-token-not-real', code: '390303' }), { status: 401 });
  const handler = createDrillHandler({ env: ENV, fetchImpl, log });
  const data = await (await handler(post(BODY))).json();
  assert.equal(data.source, 'fallback');
  assert.equal(data.targetBar, '10');
  const [level, line] = log.lines.at(-1);
  assert.equal(level, 'error');
  assert.match(line, /status=401/);
  assert.match(line, /Invalid OAuth access token/);
  assert.doesNotMatch(line, /test-token-not-real/);
});

test('drill: Cortex timeout → fallback', async () => {
  const log = quietLog();
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const handler = createDrillHandler({ env: ENV, fetchImpl, log, timeoutMs: 50 });
  const data = await (await handler(post(BODY))).json();
  assert.equal(data.source, 'fallback');
  assert.match(log.lines.at(-1)[1], /timed out after 50 ms/);
});

test('drill: network failure and empty completion → fallback', async () => {
  for (const fetchImpl of [async () => { throw new TypeError('fetch failed'); }, async () => completion('   ')]) {
    const handler = createDrillHandler({ env: ENV, fetchImpl, log: quietLog() });
    assert.equal((await (await handler(post(BODY))).json()).source, 'fallback');
  }
});

test('drill: bad input → 400, wrong type → 415, oversized → 413', async () => {
  const handler = createDrillHandler({ env: {}, log: quietLog() });
  const bad = await handler(post({ piece: 'p', bars: [] }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /bars/);
  assert.equal((await handler(post(null, { raw: '{not json' }))).status, 400);
  assert.equal((await handler(post(null, { raw: '' }))).status, 400);
  assert.equal((await handler(post(BODY, { type: 'text/plain' }))).status, 415);
  const huge = JSON.stringify({ piece: 'p', bars: [], pad: 'x'.repeat(LIMITS.maxBodyBytes) });
  assert.equal((await handler(post(null, { raw: huge }))).status, 413);
});

test('drill: 6th request from one IP within a minute → 429 with Retry-After', async () => {
  const handler = createDrillHandler({ env: {}, log: quietLog() });
  for (let i = 0; i < 5; i++) assert.equal((await handler(post(BODY, { ip: '198.51.100.1' }))).status, 200);
  const limited = await handler(post(BODY, { ip: '198.51.100.1' }));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await handler(post(BODY, { ip: '198.51.100.2' }))).status, 200);
});

test('health: GET /api/health → {"ok":true}', async () => {
  const res = health();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
