# `inventory/`

Warehouses, stock balances, movements, reservations and cost method.

An independently deployable NestJS service with its own database, its own container
and its own lifecycle. It is reached through Kong, never directly, and it shares no
source with any other module (ADR 0001).

**Status: phase 32 — complete.** Stock moves because somebody decided it should, and not
only because an order did: it is transferred between warehouses, written off with a reason
and an allowance behind it, and counted against what the shelf actually holds.

The versioned choreography with Sales is defined in `@horizon/contracts@0.19.0`. Forced-RLS PostgreSQL persistence locks every requested
balance and either holds all lines or publishes one complete rejection; confirmation
atomically converts holds into append-only shipment movements. Its inbox, outbox relay,
RabbitMQ consumer, bounded retry, circuit breaker, metrics and trace propagation are
exercised both independently and by `make test-phase7`.

---

## What this context owns

- **Warehouses** and their locations.
- **Stock balances** — on-hand and reserved quantity per item per warehouse.
- **Stock movements** — the append-only ledger from which balances are derived; a balance is never edited directly.
- **Reservations** — a hold placed against available stock, with expiry.
- **Cost method** — moving average cost, maintained per item per warehouse.
- **Transfers** — goods moving between the company's own warehouses, at the cost they left at.
- **Adjustments** — a deliberate change to how much stock there is, with a reason, and past an allowance a second person's decision.
- **Counts** — a sheet of what the system expected, what somebody found, and the difference posted between them.
- **The adjustment allowance** — the value at or above which an adjustment or a count's differences wait for somebody else.

## What it explicitly does not own

This list matters more than the one above — a bounded context is defined by its
refusals.

- **Product definitions.** `catalog/` owns what an item is; inventory holds a reference and its own projection of the few attributes it needs.
- **Order lifecycle.** `sales/` decides what an order means. Inventory answers reserve/release and nothing more.
- **Financial valuation postings.** Inventory computes cost; posting it to a ledger is `financial/` (roadmap).
- **Purchasing and receiving workflows.** Movements can be recorded; the approval process around them is out of scope.

---

## Events

### Published

| Event | Meaning |
|---|---|
| `inventory.stock.reserved` | The requested quantity is held for the referenced order. |
| `inventory.stock.reservation-rejected` | Insufficient available stock. Carries the shortfall per line so `sales/` can explain the failure. |
| `inventory.stock.released` | A reservation was released, by cancellation or by expiry. |
| `inventory.stock.moved` | A movement was recorded; balances and moving-average cost changed. |

### Consumed

| Event | Reaction |
|---|---|
| `catalog.item.created` | Projects products as stockable; services are deliberately ignored. |
| `catalog.item.deactivated` | Blocks new reservations for the item. |
| `sales.order.placed` | Attempts one atomic reservation for every order line and publishes either reserved or rejected. |
| `sales.order.confirmed` | Commits the reservation. The goods stay on the shelf, held for that customer. |
| `sales.shipment.dispatched` | The goods left: takes exactly what left out of its hold, in part or in full. |
| `sales.shipment.returned` | The delivery came back: returns the goods at the cost they left at, and to their hold. |
| `sales.order.cancelled` | Releases the order's reservation. |

Every published event is written to the `outbox` table inside the same transaction as
the state change it describes, and relayed by a poller using `FOR UPDATE SKIP LOCKED`
(ADR 0024). Delivery is at-least-once, so every consumer deduplicates against an
`inbox` table keyed on `(source_module, event_id)`.

Schemas live in `@horizon/contracts` and are versioned there (ADR 0030); this module
does not define its own wire shapes.

Every order event carries a monotonic `orderVersion`, echoed by reservation outcomes.
Inventory may receive messages out of order and must ignore an older version rather than
assuming RabbitMQ preserves aggregate ordering across retries and consumers.

---

## Endpoints

Order reservation and shipment remain event-driven. Operator commands use the HTTP
surface below and require a workspace-scoped Inventory role.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/warehouses` | List warehouse balances for the workspace. |
| `POST` | `/warehouses` | Create an active warehouse. |
| `PATCH` | `/warehouses/:id/deactivate` | Remove a warehouse from new operational work. |
| `POST` | `/stock-receipts` | Receive stock and recalculate weighted average cost. |
| `GET` | `/stock-transfers` | List what moved between warehouses. |
| `POST` | `/stock-transfers` | Move goods between two warehouses, at the cost they left at. |
| `GET` | `/stock-adjustments` | List adjustments, filtered by status or warehouse. |
| `POST` | `/stock-adjustments` | Write stock off or on, with a reason. |
| `PATCH` | `/stock-adjustments/:id/approve` | Allow somebody else's adjustment. |
| `PATCH` | `/stock-adjustments/:id/reject` | Refuse it, with a reason. |
| `GET` | `/stock-counts` | List count sheets. |
| `GET` | `/stock-counts/:id` | One sheet: expected, counted and the difference between them. |
| `POST` | `/stock-counts` | Open a sheet over a warehouse, freezing what the system expects. |
| `PATCH` | `/stock-counts/:id/figures` | Record what the counter found. |
| `PATCH` | `/stock-counts/:id/close` | Settle the sheet and post its differences. |
| `PATCH` | `/stock-counts/:id/approve` | Allow the differences of somebody else's count. |
| `PATCH` | `/stock-counts/:id/reject` | Refuse them, with a reason. |
| `PATCH` | `/stock-counts/:id/cancel` | Abandon a sheet; it posts nothing. |
| `GET` | `/adjustment-policies` | The allowance per currency. |
| `PUT` | `/adjustment-policies` | Set it. |
| `GET` | `/stock-levels` | The minimum and maximum each warehouse should keep. |
| `PUT` | `/stock-levels` | Set them for one item in one warehouse. |
| `GET` | `/stock-ledger` | The Kardex of one item on one shelf: opening, movements, closing. |
| `GET` | `/stock-position` | What every shelf holds now, with its level and any alert. |
| `GET` | `/stock-valuation` | What the company held, and what it was worth, at an instant. |
| `GET` | `/stock-alerts` | The shelves somebody should look at, worst first. |
| `GET` | `/cost-of-goods-sold` | What the goods that left for customers had cost. |
| `GET` | `/stock-abc` | Items ranked by what leaving them cost, cut into A, B and C. |

The reports are read from `stock_movements` alone, never from the balance table they are
checked against: every movement records the quantity the shelf reached **and** what a unit
was then worth, which is what lets a valuation of a past day be a lookup rather than a
replay. `from` and `to` are UTC days, bounded to a year; `asOf` defaults to now rather
than to the end of today, so a valuation never disagrees with a shelf somebody just looked
at. A stock level refuses nothing — it is read by the alert report and by nobody else, and
a minimum of zero is how a workspace turns one off without deleting the decision.

Every command that moves stock takes an `Idempotency-Key` header and runs at most once
(ADR 0028); every decision is a line in the tenant's hash-chained audit log (ADR 0025).
Approving or refusing somebody's write-off takes the Inventory **admin** role, and the
person who asked for one can never be the person who allows it — in the aggregate and in
a table constraint.

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
npm run dev          # http://localhost:3003
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
| `RESERVATION_TTL_SECONDS` | A reservation not confirmed within this window is released automatically. |
| `COST_METHOD` | The only implemented method. FIFO and standard cost are not in scope. |
| `IDEMPOTENCY_TTL_SECONDS` | 24 hours (ADR 0028). |

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
