// In-memory sliding-window rate limiter.
// Best-effort on serverless: each function instance keeps its own counters,
// and counters reset when an instance is recycled.

export function createRateLimiter({ limit = 5, windowMs = 60_000, now = () => Date.now(), maxKeys = 10_000 } = {}) {
  const hits = new Map(); // key -> timestamps (ms) inside the window

  function prune(t) {
    for (const [key, times] of hits) {
      const fresh = times.filter((x) => t - x < windowMs);
      if (fresh.length) hits.set(key, fresh);
      else hits.delete(key);
    }
  }

  return {
    check(key) {
      const t = now();
      const times = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (times.length >= limit) {
        hits.set(key, times);
        return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((windowMs - (t - times[0])) / 1000)) };
      }
      times.push(t);
      hits.set(key, times);
      if (hits.size > maxKeys) prune(t);
      return { allowed: true, remaining: limit - times.length, retryAfterSec: 0 };
    },
    reset() {
      hits.clear();
    },
  };
}

/** Best guess at the caller's IP (Vercel sets x-real-ip and x-forwarded-for). */
export function clientIp(request) {
  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || 'unknown';
}
