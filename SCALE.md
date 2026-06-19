# Scale Plan — 10k RPS

## Data model / indexes
- `signals` table already has `idx_user_created(user_id, created_at)` covering the list query.
- Add a partial index on `idempotency_key` if the column is NOT NULL to speed up duplicate lookups (already UNIQUE, so SQLite indexes it).
- At 10k RPS, switch from SQLite to PostgreSQL. Partition `signals` by month on `created_at` to keep hot data small.

## Idempotency across instances
- Move idempotency storage to a shared store (PostgreSQL or Redis).
- Use `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *` (Postgres) — single atomic operation, no application-level locking, no TOCTOU race.
- Set a TTL on idempotency keys (e.g. 24 h) using a Redis sorted set scored by expiry time, or Postgres `created_at < now() - interval '24h'` cleanup job.

## Rate limiting across instances
- Replace the in-process Map with Redis:
  ```
  INCR  rl:{userId}:{minute}   -> count
  EXPIRE rl:{userId}:{minute}  60   (set only when count == 1)
  ```
- Both commands are atomic per Redis serialization; no race conditions.
- Use `pipelining` to send both in one round-trip.

## Horizontal scaling
- Run N stateless Node pods behind a load balancer (e.g., AWS ALB or nginx).
- No sticky sessions needed — all shared state is in Redis + Postgres.
- Scale pods on CPU/request-queue depth via HPA (Kubernetes) or ECS auto-scaling.

## Load balancer
- Layer-7 LB (ALB / nginx) for HTTP routing.
- Health check on `GET /healthz`.
- Connection draining on pod shutdown so in-flight requests complete.

## Database connection pooling
- Use `pg` + `pg-pool` with `max: 20` connections per pod.
- With 10 pods that's 200 total connections — within Postgres's default 300 limit.
- For higher concurrency, put PgBouncer in front in transaction-pooling mode.

## Queues for heavy processing
- If signal processing becomes expensive (e.g., fan-out, ML inference), write to DB immediately and push a job to a queue (BullMQ / SQS).
- Workers consume from the queue independently — decouples write latency from processing latency.
- Retries and dead-letter queues are handled by the queue, not application code.

## Caching strategy
- `GET /v1/signals` results can be cached in Redis with a short TTL (1–5 s) keyed by `{userId}:{limit}`.
- Invalidate or skip cache on writes for that userId.
- For read-heavy workloads, read replicas in Postgres offload the primary.

## Observability
- Structured JSON logs (already using Fastify's pino logger).
- Emit `p50/p95/p99` latency histograms and error-rate metrics to Prometheus/Datadog.
- Alert on: error rate > 1%, p99 > 500 ms, rate-limit bucket exhausted repeatedly (abuse signal).

## Failure modes
- **DB down**: `withRetry` handles transient errors. After max retries, return 503. Circuit-breaker (e.g., `opossum`) prevents hammering a dead DB.
- **Redis down**: Fall back to in-process rate limiting with a warning log. Accept slight over-counting during the outage rather than rejecting all traffic.
- **Partial outage**: Idempotency keys in Redis with DB as source-of-truth mean a Redis miss just re-checks the DB; slightly slower, not incorrect.

## 10k RPS cost ballpark (AWS)
| Component | Size | Est. cost/mo |
|---|---|---|
| Node pods | 5× c6i.large (2 vCPU, 4 GB) | ~$350 |
| PostgreSQL | RDS db.r6g.large Multi-AZ | ~$250 |
| Redis | ElastiCache r6g.medium | ~$80 |
| Load balancer | ALB | ~$30 |
| **Total** | | **~$710/mo** |
