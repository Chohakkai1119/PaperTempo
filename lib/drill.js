// POST /api/drill: validate → pick the target bar → ask Cortex → fall back to a template.

import { json, readJsonBody } from './http.js';
import { LIMITS, validateDrillRequest } from './validate.js';
import { pickTargetBar } from './target-bar.js';
import { cortexConfig, requestCortexDrill, fallbackDrill, CORTEX_TIMEOUT_MS } from './cortex.js';
import { createRateLimiter, clientIp } from './rate-limit.js';

function redact(text, secret) {
  return secret ? String(text).split(secret).join('[redacted]') : String(text);
}

/**
 * Builds the handler. Everything is injectable so tests can run without network or env vars.
 */
export function createDrillHandler({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
  limiter = createRateLimiter({ limit: 5, windowMs: 60_000 }),
  log = console,
  timeoutMs = CORTEX_TIMEOUT_MS,
} = {}) {
  return async function drillHandler(request) {
    const rate = limiter.check(clientIp(request));
    if (!rate.allowed) {
      return json(429, { error: 'Too many drill requests. Please wait a minute and try again.' }, { 'retry-after': String(rate.retryAfterSec) });
    }

    let body;
    try {
      body = await readJsonBody(request, LIMITS.maxBodyBytes);
    } catch (error) {
      log.warn(`[drill] rejected ${error.status ?? 400}: ${error.message}`);
      return json(error.status ?? 400, { error: error.message });
    }

    const checked = validateDrillRequest(body);
    if (!checked.ok) {
      // The body is only bar labels and numbers (no audio, no credentials), so it is safe to log.
      log.warn(`[drill] rejected 400: ${checked.error} body=${JSON.stringify(body).slice(0, 2000)}`);
      return json(400, { error: checked.error });
    }

    const { piece, bars } = checked.value;
    const target = pickTargetBar(bars);
    const result = (drill, source) => json(200, { targetBar: target.bar, drill, source });

    const config = cortexConfig(env);
    if (!config) {
      log.warn('[drill] Snowflake env vars missing or invalid (SNOWFLAKE_ACCOUNT, SNOWFLAKE_PAT, SNOWFLAKE_MODEL); using fallback drill');
      return result(fallbackDrill(target), 'fallback');
    }

    try {
      const drill = await requestCortexDrill({ config, piece, target, fetchImpl, timeoutMs });
      return result(drill, 'cortex');
    } catch (error) {
      // Status and Snowflake's message only — never the token or request headers.
      log.error(`[drill] Snowflake Cortex call failed: status=${error.status ?? 'none'} message=${redact(error.message, config.pat)}`);
      return result(fallbackDrill(target), 'fallback');
    }
  };
}
