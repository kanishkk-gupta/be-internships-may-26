import { insertSignal, getByIdemKey, listSignals } from './db.js';
import { checkAndConsume } from './rateLimit.js';

// Transient SQLite error codes that are safe to retry.
const TRANSIENT_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);

// Retry fn with exponential backoff + jitter. Only retries transient errors.
// Max ~3.5s total wait across 4 attempts (100, 200, 400ms + jitter).
async function withRetry(fn, maxAttempts = 4) {
  let delay = 100;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!TRANSIENT_CODES.has(err.code) || attempt === maxAttempts) throw err;
      // jitter: sleep delay * (0.5 to 1.5) to avoid thundering herd
      const jitter = delay * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, jitter));
      delay *= 2;
    }
  }
}

export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};
  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  const { ok, remaining, resetMs } = checkAndConsume(userId, Date.now());
  if (!ok) return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });

  // If an idempotency key was sent, check for an existing record first.
  // Even if two requests race past this check simultaneously, the UNIQUE
  // constraint on idempotency_key in the DB guarantees only one insert wins.
  // The loser gets a SQLITE_CONSTRAINT error — we catch that below and
  // return the already-created row instead of failing.
  if (idem) {
    try {
      const existing = await withRetry(() => getByIdemKey(idem));
      if (existing) return existing;
    } catch (err) {
      req.log.error({ err, ctx: 'getByIdemKey' });
      return reply.code(503).send({ error: 'db_unavailable' });
    }
  }

  try {
    const t = Date.now();
    const info = await withRetry(() => insertSignal(userId, type, payload, idem, t));
    return { id: info.lastInsertRowid, userId, type, payload: String(payload), idempotencyKey: idem, createdAt: t };
  } catch (err) {
    // A UNIQUE constraint violation means a concurrent request already inserted
    // this idempotency key. Fetch and return that existing record.
    if (idem && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      try {
        const existing = await withRetry(() => getByIdemKey(idem));
        if (existing) return existing;
      } catch (e2) {
        req.log.error({ err: e2, ctx: 'getByIdemKey-fallback' });
      }
    }
    req.log.error({ err, ctx: 'insertSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });
  const lim = Math.min(Number(limit) || 20, 100);
  try {
    const rows = await withRetry(() => listSignals(userId, lim));
    return { items: rows };
  } catch (err) {
    req.log.error({ err, ctx: 'listSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}
