# `sales/`

Customers, quotes, sales orders and the invoicing trigger.

An independently deployable NestJS service with its own database, its own container
and its own lifecycle. It is reached through Kong, never directly, and it shares no
source with any other module (ADR 0001).

**Status: phase 7 — complete.** The versioned choreography with Inventory is defined in
`@horizon/contracts@0.3.0`. The domain owns customers, expiring quotes, monotonic order
transitions and immutable commercial snapshots with exact monetary arithmetic. Customer
PII is authenticated-encrypted per subject and exact tax-id lookup uses a blind index;
erasure destroys the subject key. Forced-RLS PostgreSQL persistence, inbox/outbox,
RabbitMQ transport, bounded retry, circuit breaker, metrics and cross-service tracing
are all exercised by the phase 7 E2E flow.

---

## What this context owns

- **Customers** — commercial counterparties, with the personal data that implies (ADR 0026).
- **Quotes** — priced proposals with an expiry.
- **Sales orders** and their lines, including the price snapshotted at confirmation.
- **Order lifecycle** — draft, placed, confirmed, cancelled — and the invariants of each transition.
- **The invoicing trigger** — the event that says an order is ready to be invoiced.

## What it explicitly does not own

This list matters more than the one above — a bounded context is defined by its
refusals.

- **Stock availability.** Sales asks `inventory/` to reserve and reacts to the answer; it never reads a balance to decide for itself, because the answer would be stale by the time it acted on it.
- **Product master data.** `catalog/` owns it. Sales holds a reference plus the price and description it snapshotted.
- **The invoice document, and any tax calculation.** Sales emits `sales.invoicing.requested` and stops. Producing a fiscal document is `fiscal/` (roadmap).
- **Receivables.** What the customer now owes is `financial/` (roadmap).

---

## Events

### Published

| Event | Meaning |
|---|---|
| `sales.order.placed` | An order was submitted and is awaiting stock reservation. |
| `sales.order.confirmed` | Stock is reserved and the order is committed. This is the event the golden path follows end to end. |
| `sales.order.cancelled` | The order will not proceed; holders of related state should release it. |
| `sales.invoicing.requested` | The order is ready to be invoiced. Consumed by `fiscal/` when it exists. |

### Consumed

| Event | Reaction |
|---|---|
| `catalog.item.created` | Creates the local product or service projection used for order entry. |
| `catalog.item.deactivated` | Prevents the item from being added to new orders. |
| `catalog.price.changed` | Refreshes the current price projection; confirmed order snapshots never change. |
| `inventory.stock.reserved` | Advances the order to confirmed. |
| `inventory.stock.reservation-rejected` | Fails the order with the reported shortfall. |

Every published event is written to the `outbox` table inside the same transaction as
the state change it describes, and relayed by a poller using `FOR UPDATE SKIP LOCKED`
(ADR 0024). Delivery is at-least-once, so every consumer deduplicates against an
`inbox` table keyed on `(source_module, event_id)`.

Schemas live in `@horizon/contracts` and are versioned there (ADR 0030); this module
does not define its own wire shapes.

Every order transition increments a monotonic `orderVersion`. Inventory echoes the
version it handled, so a late reservation outcome cannot move a newer or cancelled order
backward.

---

## Endpoints

Every business endpoint requires a workspace-scoped Identity access token. Customer
erasure is the irreversible crypto-shredding operation from ADR 0026; it is deliberately
not presented as an ordinary row deletion.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/customers` | List the workspace customer directory. |
| `POST` | `/customers` | Create and encrypt a customer record. |
| `DELETE` | `/customers/:id` | Permanently erase customer PII while preserving document references. |
| `GET` | `/quotes` | List recent commercial quotes. |
| `GET` | `/quotes/:id` | Read a quote and its immutable priced lines. |
| `POST` | `/quotes` | Create a quote using current Catalog projections. |
| `POST` | `/quotes/:id/accept` | Accept an open, unexpired quote. |
| `GET` | `/orders` | List recent sales orders. |
| `GET` | `/orders/:id` | Read one order snapshot. |
| `POST` | `/orders` | Place an order and start the Inventory choreography. |

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
npm run dev          # http://localhost:3004
```

Integration and e2e tests need a Docker socket — they start their own PostgreSQL,
Redis and RabbitMQ via Testcontainers rather than using a shared instance (ADR 0013):

```bash
npm run test:e2e
```

Migrations:

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
| `DATABASE_RELAY_URL` | Optional relay-only role. When present, the service runs its embedded outbox worker. |
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
| `QUOTE_DEFAULT_VALIDITY_DAYS` | Default expiry applied to a new quote. |
| `CUSTOMER_BLIND_INDEX_KEY` | 32-byte lowercase hex key for exact customer tax-id lookup without plaintext indexes. |
| `ORDER_CONFIRMATION_TIMEOUT_MS` | How long an order waits for a reservation outcome before failing (ADR 0027). |

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
