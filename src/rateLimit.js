const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;

// In-process store: { userId -> { windowStart: number, count: number } }
// This is single-instance only. For multi-instance safety, see comment below.
const buckets = new Map();

// Multi-instance safety note:
// Replace this Map with Redis atomic operations:
//   const count = await redis.incr(key);          // atomic increment
//   if (count === 1) await redis.expire(key, 60); // set TTL only on first request
//   return count <= RATE;
// Using INCR+EXPIRE on a per-user-per-minute key (e.g. "rl:{userId}:{minute}")
// ensures no race conditions across pods because Redis serializes commands.

export function checkAndConsume(userId, nowMs = Date.now()) {
  let bucket = buckets.get(userId);

  // If no bucket exists, or the current window has expired, start a fresh window.
  if (!bucket || nowMs >= bucket.windowStart + WINDOW_MS) {
    bucket = { windowStart: nowMs, count: 0 };
  }

  bucket.count += 1;
  buckets.set(userId, bucket);

  const ok = bucket.count <= RATE;
  const remaining = Math.max(RATE - bucket.count, 0);
  const resetMs = bucket.windowStart + WINDOW_MS;
  return { ok, remaining, resetMs };
}
