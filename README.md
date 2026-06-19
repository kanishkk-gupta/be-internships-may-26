# Signals Challenge (Node.js + Fastify)

Build a minimal production-leaning service that can **handle load**, **rate limit**, and **avoid duplicates** via idempotency.

## Endpoints (to keep)
- `POST /v1/signals`
  - body: `{ "userId": "string", "type": "string", "payload": "string" }`
  - headers: `X-API-Key`, `Idempotency-Key` (optional)
  - behaviors:
    - **Rate limit** per `userId`: `RATE_LIMIT_PER_MIN` per minute (default 5).
    - **Idempotency**: same `Idempotency-Key` should not create duplicates.
- `GET /v1/signals?userId=...&limit=...`
- `GET /healthz`

## Your Tasks
1. **Implement a robust rate limiter** in `src/rateLimit.js`.
2. **Make idempotency safe across scale** in `src/signals.js`.
3. **Handle DB failure** gracefully with retry/backoff.
4. **Think for 10k RPS.** Add a `SCALE.md`.
5. **Finish the tests** in `tests/*.test.js`.

## Deliverables
- Working service, passing tests, updated README, SCALE.md.
- Optional deploy link.
---

## Extra Production Constraints (must pass)

- **Atomic Idempotency:** Survive concurrent requests and restarts. Avoid check-then-insert races; use a DB-level unique constraint or atomic upsert pattern. Return the same resource for identical `Idempotency-Key`.
- **Concurrency-Safe Rate Limit:** Must behave correctly under burst and parallel calls. Naive in-memory counters that race will fail hidden checks. Explain how this becomes multi-instance safe.
- **Transient DB Failures:** Implement retry/backoff (with jitter) or circuit breaker when DB errors occur (we simulate via `DB_FAIL_RATE`). No duplicates on retry.
- **Scale Plan (10k RPS):** Fill `SCALE.md` with a clear, concise approach (indexes, pooling, caching, queues, horizontal scale, idempotency store).

> We will run additional **hidden concurrency/multi-instance tests** during evaluation.

---

## Solution Summary

### Features implemented

- **Rate limiting** (`src/rateLimit.js`): fixed-window counter per `userId`, default 5 requests/minute, configurable via `RATE_LIMIT_PER_MIN`.
- **Idempotency** (`src/signals.js`): check-before-insert with UNIQUE constraint as the real race guard; concurrent constraint violations are caught and resolved by fetching the winning row.
- **Retry with exponential backoff and jitter** (`src/signals.js` `withRetry`): up to 4 attempts, initial delay 100ms, doubles each round, ±50% jitter to avoid thundering herd. Retries only `SQLITE_BUSY` / `SQLITE_LOCKED` (transient). Non-transient errors and constraint violations are not retried as inserts.
- **Scale plan** (`SCALE.md`): covers indexes, connection pooling, Redis-based distributed rate limiting, horizontal scaling, idempotency store, queues, caching, and observability.

### Architecture decisions

**Why the UNIQUE constraint was chosen for idempotency:**
A UNIQUE constraint on `idempotency_key` in the `signals` table means the database enforces uniqueness atomically — no two rows with the same key can exist, even under concurrent inserts. Application code does an optimistic insert and catches `SQLITE_CONSTRAINT_UNIQUE` if it loses the race. The winning insert's row is then fetched and returned. This avoids the classic check-then-insert TOCTOU race entirely: even if two requests both pass the pre-check and both call `insertSignal`, only one insert succeeds. The other gets a deterministic error and recovers gracefully.

**Why fixed-window rate limiting was chosen:**
Fixed-window counters are simple, stateless within a window, and trivially mapped to an atomic Redis INCR. The trade-off is a potential 2× burst at a window boundary (e.g., 5 requests at second 59 and 5 more at second 61 of the next window). For this service that is acceptable. A sliding-window log would need per-request timestamps stored per user, which is more expensive at scale.

**Why Node.js is safe here for single-instance rate limiting:**
JavaScript in Node.js is single-threaded with no true parallelism within a process. The in-memory `Map` counter has no race conditions in a single process — concurrent HTTP handlers are interleaved on the event loop, not run in parallel. For multi-instance deployments this breaks and must move to Redis (see `SCALE.md` and the comment in `rateLimit.js`).

### Retry / backoff approach

`withRetry(fn, maxAttempts=4)` wraps any synchronous DB call. On a transient error it waits `delay * rand(0.5, 1.5)` ms before retrying, doubling `delay` each round (100 → 200 → 400ms base). Max cumulative wait before giving up is roughly 3.5 seconds. The function is idempotent-safe: if an insert retry hits a UNIQUE constraint instead of a transient error, it falls through to the constraint-violation handler rather than retrying.

### Multi-instance scaling approach

Documented in `SCALE.md`. Short version:
- Rate limiting: `INCR rl:{userId}:{minute}` + `EXPIRE 60` in Redis — atomic, no application locks needed.
- Idempotency: `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *` in PostgreSQL — single round-trip, no pre-check needed.
- State: both stores are shared across all pods; the Node servers themselves remain stateless.

### Test results (measured)

```
TAP version 13
ok 1 - idempotency returns same resource for same key   (916ms)
ok 2 - rate limit: allow 5 per minute, 6th is 429      (982ms)

# tests 2  |  pass 2  |  fail 0
```

### Benchmark results (measured, `npm run bench` on local Windows machine)

`npx autocannon -c 20 -d 10 -p 3 http://localhost:8080/healthz`

| Stat | p50 | p97.5 | Avg | Max |
|---|---|---|---|---|
| Latency | 4 ms | 36 ms | 7.45 ms | 180 ms |
| Req/sec | 4,199 | 19,727 | 7,554 | — |

76k requests in 10s on a local developer machine (Windows, single process, SQLite). Latency spikes at p97.5 are expected — SQLite serializes all writes.

### Adversarial verification (manually tested)

| Scenario | Result |
|---|---|
| Sequential duplicate `Idempotency-Key` | Both calls return identical `id` and body ✅ |
| 3 concurrent requests with same `Idempotency-Key` | All three return identical `id: 32`, status 200 ✅ |
| Server restart, same `Idempotency-Key` re-sent | Returns original `id` (persisted in SQLite) ✅ |
| 6 sequential requests same `userId` with limit 5 | Statuses `[200,200,200,200,200,429]` ✅ |
| `DB_FAIL_RATE=0.5`, 20 requests with unique userIds | 18 ok, 2 gave 503 (expected ~93.75% success rate) ✅ |

### Known limitations

- **Rate limiter is per-process only.** Multiple server instances will have independent counters. A user could exceed the rate limit proportionally to the number of pods. See `SCALE.md` for the Redis fix.
- **SQLite is single-writer.** Under write-heavy load, `SQLITE_BUSY` errors increase. The retry logic absorbs transient bursts but SQLite is not suitable above a few hundred writes/second.
- **No idempotency key TTL.** Keys live forever in the current schema. A cleanup job (cron or Postgres partition drop) would be needed in production.
- **Fixed-window burst.** Up to 2× the rate limit is theoretically possible across a window boundary.

### Future improvements

- Swap SQLite for PostgreSQL and use `INSERT ... ON CONFLICT DO NOTHING RETURNING *` for atomic idempotency without a pre-check.
- Move rate limiting to Redis (INCR + EXPIRE) for multi-instance correctness.
- Add a background job to prune idempotency keys older than 24 hours.
- Add `X-RateLimit-Remaining` and `X-RateLimit-Reset` response headers.
- Add a circuit breaker (e.g., `opossum`) around DB calls to stop hammering a dead database.
