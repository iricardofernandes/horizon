# How every service runs

What is the same in all sixteen services. Each module's README lists only what is its
own and links here for the rest.

## Commands

Every service is an independent npm project:

```bash
npm install
cp .env.example .env   # the service refuses to start on invalid configuration

npm run typecheck      # tsc, strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
npm run lint           # biome
npm test               # unit tests: no I/O, in-memory repositories
npm run test:e2e       # real PostgreSQL, Redis and RabbitMQ through Testcontainers
npm run dev            # the service, on its own port
```

- `npm run db:generate` emits SQL from the Drizzle schema.
- `npm run db:migrate` applies it with the owner role, which the running service never uses.
- `npm run build` compiles with SWC. `tsc` typechecks but does not emit, so CI and the
  Dockerfile run both.

The e2e suites need a Docker socket. They start their own containers instead of sharing
a database, because roles and forced RLS are cluster-level settings, and those are
exactly what the tests exercise ([ADR 0013](adr/0013-vitest-with-testcontainers.md)).

## Code layout

```text
src/
  domain/          aggregates, value objects and events; no framework, ORM or Zod
  application/     use cases, returning Either for expected failures
  infrastructure/  HTTP controllers, Drizzle repositories, the RabbitMQ transport
  main/            composition root, configuration and entry points
test/              Testcontainers e2e suites
```

- **Dependencies point inward only.** `scripts/check-boundaries.mjs` enforces it
  ([ADR 0031](adr/0031-layering-and-object-calisthenics.md)).
- **Errors.** Expected failures are values (`Either`). At the edge they become RFC 9457
  `application/problem+json` ([ADR 0032](adr/0032-either-for-expected-failures-rfc9457-at-the-boundary.md)).
- **Tenant isolation is tested.** Every aggregate has a test that writes as one tenant
  and proves another tenant cannot read it.

## Guarantees every service gives

- **Tenant isolation in the database.** Every business table has `tenant_id` and forced
  RLS. Every query runs in a transaction that sets the tenant first, and no repository can
  obtain a raw connection ([ADR 0017](adr/0017-row-level-security-and-tenant-aware-transaction.md)).
- **No lost events.** An event is written to the `outbox` in the same transaction as the
  change it describes. A relay publishes it with `FOR UPDATE SKIP LOCKED`, so several
  relays can run at once ([ADR 0024](adr/0024-transactional-outbox-and-inbox.md)).
- **No double effects.** Delivery is at least once, so every consumer records each event
  in an `inbox` in the same transaction as its effect.
- **A dead letter is never silent.** An event a consumer cannot handle goes to that
  consumer's own dead-letter queue, where it can be inspected and replayed.
- **Idempotent writes.** A command that creates something takes an `Idempotency-Key` and
  runs at most once under it ([ADR 0028](adr/0028-idempotency-key-on-public-writes.md)).
- **Every token is verified twice.** Kong validates it, and the service verifies it again
  against Identity's JWKS, so reaching a service's port directly grants nothing.
- **Bounded outbound calls.** Every call has a timeout, retries with jitter and a circuit
  breaker ([ADR 0027](adr/0027-resilience-policy-for-outbound-calls.md)).
- **An audit log that cannot be rewritten.** Each service that records business decisions
  keeps its own append-only, hash-chained log. Where it is exposed, `GET /audit` reads it
  with the chain's verdict on every page
  ([ADR 0025](adr/0025-append-only-audit-log-with-hash-chain.md)).
- **Exact money.** Amounts are integer minor units with an explicit currency
  ([ADR 0010](adr/0010-money-as-integer-minor-units.md)).

## Configuration every service shares

Configuration is validated with Zod at boot, so a missing or malformed value stops the
process instead of failing on first use. Defaults are in each module's `.env.example`.

| Variable | Purpose |
|---|---|
| `PORT`, `NODE_ENV`, `LOG_LEVEL` | HTTP port and logging |
| `DATABASE_URL` | The application role, without `SUPERUSER` or `BYPASSRLS`, so RLS applies to it |
| `DATABASE_MIGRATION_URL` | The owner role, used only by `db:migrate` |
| `DATABASE_RELAY_URL` | The relay role; when set, the service runs its outbox relay |
| `DATABASE_POOL_MAX`, `DATABASE_STATEMENT_TIMEOUT_MS` | Pool size and query timeout |
| `REDIS_URL` | Token denylist, idempotency records, rate counters |
| `RABBITMQ_URL`, `AMQP_PREFETCH` | The broker, and how many messages are in flight |
| `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE` | How often and how much the relay publishes |
| `INBOX_RETENTION_DAYS` | How long deduplication records are kept |
| `IDEMPOTENCY_TTL_SECONDS` | How long an `Idempotency-Key` is remembered |
| `HTTP_CLIENT_TIMEOUT_MS`, `CIRCUIT_BREAKER_*` | Bounds on every outbound call |
| `JWKS_URL`, `TRUST_GATEWAY_JWT` | Identity's public keys; `false` means the service verifies every token itself |
| `OTEL_*` | Telemetry, sent only to the OpenTelemetry Collector |
| `TENANT_ID_HASH_SALT` | Tenant ids are hashed before they appear in logs and metrics |

## Health

Every NestJS service answers `GET /health/live` and `GET /health/ready`, and Fiscal
answers `GET /health`.
