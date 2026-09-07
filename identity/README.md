# `identity/`

Tenants, users, authentication, sessions, API keys, JWKS and role assignment.

An independently deployable NestJS service with its own database, its own container
and its own lifecycle. It is reached through Kong, never directly, and it shares no
source with any other module (ADR 0001).

**Status: phase 1 — scaffold.** Configuration, tooling and documentation are real;
there is no domain code yet. See [`docs/plan.md`](../docs/plan.md) for what arrives
when.

---

## What this context owns

- **Tenants** — the isolation unit every other module scopes its data by.
- **Users and credentials** — Argon2id password hashes, rehashed on login when below policy.
- **Sessions** — refresh-token families, rotated on every use, with reuse detection.
- **Access tokens** — EdDSA (Ed25519) signing, `kid` rotation, and the public JWKS document.
- **API keys** — `hz_<env>_<prefix>_<secret>`, prefix indexed, secret Argon2id-hashed, explicit scopes.
- **Role assignments** — opaque `{ module, role }` pairs attached to a user.
- **Data-subject keys** — the per-subject encryption keys whose destruction is erasure.

## What it explicitly does not own

This list matters more than the one above — a bounded context is defined by its
refusals.

- **What a role means.** Identity stores `(module, role)` pairs and cannot expand them. Each module owns its own `role → permissions` map and validates the claim on arrival (ADR 0023).
- **Customers.** A customer is a commercial counterparty and belongs to `sales/`. A user is someone who logs in. They are different concepts with different lifecycles.
- **Any business data.** Identity knows who you are, never what you sold.
- **Authorization decisions.** It mints claims; the module receiving the request decides.

---

## Events

### Published

| Event | Meaning |
|---|---|
| `identity.tenant.created` | A tenant now exists; downstream modules may create tenant-scoped defaults. |
| `identity.user.registered` | A user was created within a tenant. |
| `identity.user.disabled` | Access revoked; consumers should drop cached authorization state. |
| `identity.api-key.revoked` | A key is no longer valid; the gateway and caches must forget it. |
| `identity.session.reuse-detected` | A rotated refresh token was replayed. Security-relevant; the family was destroyed. |
| `identity.data-subject.erased` | A data-subject key was destroyed. Consumers holding personal data for that subject must shred their own copies. |

### Consumed

This module consumes no events. It is upstream of everything else.

Every published event is written to the `outbox` table inside the same transaction as
the state change it describes, and relayed by a poller using `FOR UPDATE SKIP LOCKED`
(ADR 0024). Delivery is at-least-once, so every consumer deduplicates against an
`inbox` table keyed on `(source_module, event_id)`.

Schemas live in `@horizon/contracts` and are versioned there (ADR 0030); this module
does not define its own wire shapes.

---

## Endpoints

None yet — this module is a scaffold. Its HTTP surface arrives with its phase, and
OpenAPI is generated from the controllers and Zod schemas at that point, aggregated at
the gateway and published by CI.

| Method | Path | Purpose |
|---|---|---|
| — | — | *(none in phase 1)* |

---

## Running it locally

The platform (PostgreSQL, Redis, RabbitMQ, Kong, the observability plane) is a phase 2
deliverable. Until then this module runs standalone and serves 404s, which is enough to
verify the toolchain.

```bash
npm install          # or npm ci
cp .env.example .env # fill in; the process refuses to start on invalid config

npm run typecheck    # tsc --noEmit, strict plus the three extra flags
npm run lint         # biome check
npm test             # unit tests: no I/O, in-memory fakes
npm run dev          # http://localhost:3001
```

Integration and e2e tests need a Docker socket — they start their own PostgreSQL,
Redis and RabbitMQ via Testcontainers rather than using a shared instance (ADR 0013):

```bash
npm run test:e2e
```

Migrations, once this module has a schema:

```bash
npm run db:generate  # emit SQL from the Drizzle schema
npm run db:migrate   # apply, using DATABASE_MIGRATION_URL (owner role)
```

### Build

```bash
npm run build        # SWC → dist/, rewriting the @/* alias
npm start
```

`tsc` typechecks but does not emit; SWC emits but does not typecheck. Both run in CI,
and the Dockerfile runs both.

---

## Environment

Every variable is required unless a default is shown in `.env.example`. Configuration
is validated with Zod at boot, so a missing or malformed value stops the process
immediately rather than surfacing as a failure on first use.

| `NODE_ENV` | — |
| `PORT` | HTTP port. Behind Kong in every environment; exposed directly only in local development. |
| `LOG_LEVEL` | pino level. `info` in production. |
| `DATABASE_URL` | Application role. Holds neither SUPERUSER nor BYPASSRLS, so RLS applies to it (ADR 0017). |
| `DATABASE_MIGRATION_URL` | Owner role, used only by `db:migrate`. The application never connects with it. |
| `DATABASE_POOL_MAX` | Bulkhead: the pool this service may consume (ADR 0027). |
| `DATABASE_STATEMENT_TIMEOUT_MS` | No query waits without a bound. |
| `REDIS_URL` | Denylist, idempotency records, rate counters. |
| `RABBITMQ_URL` | — |
| `AMQP_PREFETCH` | Bounded consumer concurrency (ADR 0027). |
| `OUTBOX_POLL_INTERVAL_MS` | Relay poll interval; the floor on publish latency (ADR 0024). |
| `OUTBOX_BATCH_SIZE` | Rows claimed per poll with FOR UPDATE SKIP LOCKED. |
| `INBOX_RETENTION_DAYS` | Must exceed the maximum possible redelivery window. |
| `IDEMPOTENCY_TTL_SECONDS` | 24 hours (ADR 0028). |
| `HTTP_CLIENT_TIMEOUT_MS` | Every outbound HTTP call. There is no unbounded wait anywhere. |
| `CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENT` | — |
| `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` | How long the breaker stays open before half-open probing. |
| `JWKS_URL` | Identity's public keys, for local token re-verification. |
| `TRUST_GATEWAY_JWT` | When false the service re-verifies every token itself, so reaching its port directly grants nothing (ADR 0008). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The Collector. Nothing talks to a backend directly (ADR 0033). |
| `OTEL_SERVICE_NAME` | — |
| `OTEL_TRACES_SAMPLER_ARG` | Full sampling locally; errors are always sampled. |
| `TENANT_ID_HASH_SALT` | Tenant ids are hashed before appearing in logs and metrics (ADR 0033). |
| `JWT_PRIVATE_KEY_PATH` | Active signing key. Mounted in dev, AWS Secrets Manager in the Terraform definition. Never committed. |
| `JWT_PUBLIC_KEYS_DIR` | Directory of public keys; every file becomes a JWKS entry, which is how rotation overlaps. |
| `JWT_ACTIVE_KID` | Which `kid` new tokens are signed with. |
| `ACCESS_TOKEN_TTL_SECONDS` | 15 minutes (ADR 0018). |
| `REFRESH_TOKEN_ABSOLUTE_TTL_SECONDS` | 30 days from family creation, regardless of use. |
| `REFRESH_TOKEN_IDLE_TTL_SECONDS` | 7 days since last use. |
| `REFRESH_TOKEN_REUSE_GRACE_MS` | Window in which the immediately-previous token returns the same replacement, so two tabs racing a refresh is not treated as theft. |
| `ARGON2_MEMORY_KIB` | OWASP minimum (ADR 0019). |
| `ARGON2_TIME_COST` | — |
| `ARGON2_PARALLELISM` | — |
| `API_KEY_ENV` | The `<env>` segment of issued keys: dev, test or live. |
| `DATA_SUBJECT_KEY_MODE` | `table` in dev, `kms` in the Terraform definition (ADR 0026). |
| `BLIND_INDEX_KEY_PATH` | Service-wide HMAC key making encrypted emails searchable by exact match only. |

---

## Conventions this module follows

- **Layering** — `src/domain/`, `src/application/`, `src/infrastructure/`, `src/main/`,
  dependencies pointing inward only. `domain/` imports no framework, no ORM and no Zod;
  `scripts/check-boundaries.mjs` enforces it (ADR 0031, ADR 0002).
- **Tenancy** — every business table carries `tenant_id` with forced RLS, and every
  query runs inside a `TenantAwareTransaction` that issues `SET LOCAL
  app.current_tenant` first. No repository can obtain a raw connection (ADR 0017).
- **Errors** — use cases return `Either<Error, Value>` for expected failures; a global
  filter maps error classes to RFC 9457 `application/problem+json` (ADR 0032).
- **Tests** — every test creates its own tenant, and every aggregate has a test that
  writes under tenant A and asserts tenant B cannot read it (ADR 0014).
