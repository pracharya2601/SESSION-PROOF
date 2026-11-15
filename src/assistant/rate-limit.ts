/**
 * Sliding-window limiter for assistant messages (per provider + session).
 * In-memory per Worker isolate: a best-effort cost guard, not a security boundary
 * (auth + ownership are). Keys are ids only.
 */
export interface Limiter {
  hit(key: string, nowMs: number): { ok: true } | { ok: false; retryAfterMs: number };
}

export const ASSISTANT_LIMIT_PER_HOUR = 30;

export function createLimiter(limit = ASSISTANT_LIMIT_PER_HOUR, windowMs = 60 * 60 * 1000, maxKeys = 5000): Limiter {
  const hits = new Map<string, number[]>();
  return {
    hit(key, nowMs) {
      const from = nowMs - windowMs;
      const list = (hits.get(key) ?? []).filter((t) => t > from);
      if (list.length >= limit) {
        hits.set(key, list);
        return { ok: false, retryAfterMs: Math.max(1000, list[0]! + windowMs - nowMs) };
      }
      list.push(nowMs);
      hits.delete(key);
      hits.set(key, list);
      // Bound memory: drop the least recently used keys.
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
      }
      return { ok: true };
    },
  };
}

/** Shared by all requests in this isolate. */
export const defaultLimiter: Limiter = createLimiter();
