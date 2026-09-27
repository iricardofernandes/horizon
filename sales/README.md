# `sales/`

A projection of the customers in `parties/`, quotes, sales orders and the invoicing trigger.

An independently deployable NestJS service with its own database, its own container
and its own lifecycle. It is reached through Kong, never directly, and it shares no
source with any other module (ADR 0001).

**Status: phase 30 — complete.** An order is picked, packed and sent — in parts if that is
how it goes — and what comes back comes back. The stock leaves when a delivery leaves, and
so does the money.

**Phase 29 — complete.** The versioned choreography with Inventory is defined in
`@horizon/contracts@0.17.0`, which also carries the quote facts and the instalments a
confirmed order was agreed under. A quote is negotiated in versions, a deep discount waits
for a second person, and an accepted offer converts into exactly one order at the prices it
agreed. The domain owns customers, expiring quotes, monotonic order
transitions and immutable commercial snapshots with exact monetary arithmetic. Customer
PII is authenticated-encrypted per subject and exact tax-id lookup uses a blind index;
erasure destroys the subject key. Forced-RLS PostgreSQL persistence, inbox/outbox,
RabbitMQ transport, bounded retry, circuit breaker, metrics and cross-service tracing
are all exercised by the phase 7 E2E flow.

---

## What this context owns

- **The customer projection** — parties holding the `customer` role, fed by `parties/` events (ADR 0040). Sales no longer registers or erases customers.
- **Quotes** — priced offers with an expiry, negotiated in versions: a sent quote is never rewritten, and the version that answers it supersedes it while sharing its identifier.
- **Discount approval** — how deep a discount a seller may give alone, and the four-eyes rule for anything deeper.
- **Attribution** — a quote may name a CRM opportunity. Sales checks it against its own projection of `crm.opportunity.*` (known, open, of the same customer) and freezes the owner and source it read there on the first version; every later version keeps them, and the quote events carry them (Phase 58). A request can name the opportunity but never describe it.
- **Commercial terms** — the seller, discount, freight, carrier, payment terms and notes, on the quote and on the order it becomes.
- **Sales orders** and their lines, including the price snapshotted at confirmation. A sales order is a **goods order**: a service item is refused when an order is placed or an accepted proposal is converted, before anything reaches Inventory (ADR 0056). Services are delivered by service orders (Phase 50).
- **Service orders** (Phase 50) — services sold directly or converted from an accepted proposal, `scheduled` → `in_progress` → `completed` → `accepted` (or `cancelled` with a reason), delivered in **deliveries**. A delivery is billed once when it is recorded; a cancelled delivery stays in the record and its work is owed again. A service order has no warehouse and never reaches Inventory.
- **Service contracts** (Phase 51) — services sold for a recurring fee: monthly, quarterly or yearly periods from the first of a month, in immutable **revisions** that apply from a period start. Amendments, suspensions, resumptions and cancellations only take effect at a period that has not begun; a renewal adds a revision the day after the end, for the original term, optionally readjusted. `GET /contracts/:id/schedule` answers which periods are billable, with which revision and for how much.
- **Period billing** (Phase 52) — a contract period is billed once, from its billing day, and frozen as it was billed: revision, lines, amounts and installments. A **billing run** for a competence month has a preview and records, per contract, whether it billed, skipped or refused the period and why; it is started under an `Idempotency-Key` and resumed after a stop. A **credit** takes back a whole billed period, which stays in the record. A change can no longer take effect at a billed period. Sales follows each billed period's receivable and NFS-e from their owners' events, and `GET /contract-billing/overview` lists what is still missing.
- **Order lifecycle** — draft, placed, confirmed, cancelled — and the invariants of each transition.
- **Shipments** — what is being picked for a customer, what left, and what came back, each carrying its share of the order's total.
- **Fulfilment state** — how much of the order has reached the customer, and what it still has to deliver.
- **The audit trail** — every decision on a quote and every order placed, in the tenant's hash-chained log (ADR 0025).
- **The invoicing trigger** — the event that says an order is ready to be invoiced.

## What it explicitly does not own

This list matters more than the one above — a bounded context is defined by its
refusals.

- **Stock availability.** Sales asks `inventory/` to reserve and reacts to the answer; it never reads a balance to decide for itself, because the answer would be stale by the time it acted on it.
- **Product master data.** `catalog/` owns it. Sales holds a reference plus the price and description it snapshotted.
- **The invoice document, and any tax calculation.** Sales emits `sales.invoicing.requested` and stops. Producing a fiscal document is `fiscal/` (roadmap).
- **The stock itself.** `inventory/` holds and moves it; Sales says what left, and the movement follows.
- **Receivables.** What the customer owes, and when, is `financial/`. Sales publishes the schedule that was agreed; deciding how the money is collected is not its business.

---

## Events

### Published

| Event | Meaning |
|---|---|
| `sales.order.placed` | An order was submitted and is awaiting stock reservation. |
| `sales.order.confirmed` | Stock is reserved and the order is committed, with the instalments it was agreed under. This is the event the golden path follows end to end. |
| `sales.order.cancelled` | The order will not proceed; holders of related state should release it. |
| `sales.invoicing.requested` | A delivery is ready to be invoiced — an invoice is written for what was shipped. Consumed by `fiscal/` when it exists. |
| `sales.shipment.dispatched` | Goods left for the customer: the stock comes out of its hold and the delivery's share of the order becomes owed. |
| `sales.shipment.returned` | A delivery came back: the goods and what they made owed both go back. |
| `sales.quote.sent` | This version of an offer was put in front of the customer. Carries `attribution` when the quote was made for an opportunity. |
| `sales.quote.accepted` | The customer agreed to it. Nothing is committed until it is converted. CRM converts the attributed opportunity. |
| `sales.quote.rejected` | The customer declined it, with the reason they gave. |
| `sales.service.delivered` | Work of a service order was delivered: one receivable per delivery in `financial/`, one NFS-e per delivered line in `fiscal/` (keyed by the line's `entryId` and competence month). |
| `sales.contract.activated` | A service contract took effect with its first revision. |
| `sales.contract.amended` | A revision applies from a period start: an amendment, or a renewal that extends the end. |
| `sales.contract.suspended` | Periods from a start (until a resumption, when known) are not billed. Published again with the resumption. |
| `sales.contract.cancelled` | No period is billed from a start on; earlier periods are untouched. |
| `sales.contract-period.billed` | A contract period was billed: one receivable in `financial/` keyed by `billedPeriodId`, one NFS-e per line in `fiscal/` keyed by the line's `entryId` and the competence month. |
| `sales.contract-period.credited` | A billed period was credited in full: its receivable is withdrawn or reversed and its NFS-e cancelled (reason 2 when not provided, 1 when billed in error). |
| `sales.service.delivery-cancelled` | A delivery was not provided after all: its receivable is withdrawn or reversed and its NFS-e cancelled. |

### Consumed

| Event | Reaction |
|---|---|
| `catalog.item.created` | Creates the local item projection used for order entry, with its immutable kind (`product` or `service`); a replay never changes a recorded kind. |
| `catalog.item.deactivated` | Prevents the item from being added to new orders. |
| `catalog.price.changed` | Refreshes the current price projection; confirmed order snapshots never change. |
| `inventory.stock.reserved` | Advances the order to confirmed. |
| `inventory.stock.reservation-rejected` | Fails the order with the reported shortfall. |
| `financial.receivable.posted` | For origin `sales-contract-period` or `sales-service-delivery`, records the posted receivable on the billed period or the delivery. |
| `financial.receivable.reversed` | Records the reversal on the billed period or delivery that raised the title, if any. |
| `crm.opportunity.created`, `revised`, `owner-changed`, `won`, `lost`, `reopened`, `converted` | Keeps the opportunity projection a quote's attribution is read from: account, owner, source and status, each set only by a fact at least as recent as the last one. |
| `fiscal.service-document.simulation-outcome` | For a `contract-period` or `service-delivery` source key, records the NFS-e outcome on the billed or delivered line. |

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

## Item kinds (Phase 49)

Quote and order lines expose `kind` (`product`, `service`, or `null` for an item projected
before Phase 49, which is treated as a good). Items projected before Phase 49 get their
kind from a one-off, idempotent command that reads the Catalog API and fills only unknown
kinds:

```sh
CATALOG_URL=http://localhost:8000/catalog CATALOG_TOKEN=<catalog read token> \
  npm run backfill:item-kinds -- --tenant <uuid>
```

It needs `DATABASE_URL` and `CUSTOMER_BLIND_INDEX_KEY` as the service does, and records one
audit entry per run.

---

## Service orders (Phase 50)

A delivery bills its share of the order total: the discount is carried in proportion to
the work, and the delivery that completes the order bills whatever the active deliveries
have not, so a completed order's deliveries add up to its total exactly. The installments
come from the order's payment terms, dated from the performed day. Converting a proposal
splits its discount between goods and services by their net; freight belongs to the goods,
so a proposal with freight and no goods is refused. A recorded delivery is never rewritten
(a database trigger enforces it).

---

## Endpoints

Every business endpoint requires a workspace-scoped Identity access token. Customers are
registered and erased in `parties/`, so they are read here and written nowhere (ADR 0040).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/customers` | List the workspace customer directory, projected from `parties/`. |
| `GET` | `/quotes` | List recent commercial quotes. |
| `GET` | `/quotes/:id` | Read a quote and its priced lines. |
| `POST` | `/quotes` | Write a quote using current Catalog projections. An optional `opportunityId` attributes it to a CRM opportunity; the owner and source come from Sales's projection, never from the body. |
| `POST` | `/quotes/:id/revise` | Correct a draft, or answer a sent offer with a new version of it. |
| `POST` | `/quotes/:id/send` | Put the offer in front of the customer, or ask for the discount to be approved. |
| `POST` | `/quotes/:id/approve` | Grant a discount somebody else asked for. |
| `POST` | `/quotes/:id/refuse` | Refuse it, with a reason, sending the offer back to draft. |
| `POST` | `/quotes/:id/accept` | Record that the customer agreed to an open, unexpired offer. |
| `POST` | `/quotes/:id/decline` | Record that they declined it, with the reason. |
| `POST` | `/quotes/:id/expire` | Record that nobody answered in time. |
| `POST` | `/quotes/:id/order` | Convert the accepted offer: its goods into a sales order (a `fulfillmentWarehouseId` is required only then) and its services into a service order. Answers `orderId` and `serviceOrderId`, either of which may be `null`. |
| `GET` | `/service-orders` | List recent service orders with their deliveries. |
| `POST` | `/service-orders` | Open a service order directly: service items only, priced from the Catalog projection. |
| `GET` | `/service-orders/:id` | Read one service order: lines with delivered quantities, deliveries, billed total, and each delivery's receivable and each delivered line's NFS-e as Financial and Fiscal reported them (Phase 53). |
| `POST` | `/service-orders/:id/start` | Start the work. |
| `POST` | `/service-orders/:id/deliveries` | Record delivered work (`lines`, or everything still owed; `performedOn`, the local day it was done). The delivery that completes the work completes the order. |
| `POST` | `/service-orders/:id/accept` | Record the customer's acceptance of completed work. |
| `POST` | `/service-orders/:id/cancel` | Cancel an order with no active delivery, with the reason. |
| `POST` | `/service-orders/:id/deliveries/:deliveryId/cancel` | Cancel a delivery that was not provided, with the reason. |
| `GET` | `/contracts` | List recent service contracts with their revisions and status today. |
| `GET` | `/contracts/:id` | Read one contract: revisions, suspensions, cancellation, status today. |
| `GET` | `/contracts/:id/schedule?from=&to=` | The periods in a range: competence, billing day, revision, amount, billable or why not. |
| `POST` | `/contracts` | Draft a contract: service lines (Catalog price, or a negotiated `unitPrice`), recurrence, start, optional end, billing day, auto-renewal, payment terms. |
| `POST` | `/contracts/:id/activate` | Put the draft into effect. |
| `POST` | `/contracts/:id/amendments` | A new revision from a period that has not begun: lines, quantities, prices, recurrence, with a reason. |
| `POST` | `/contracts/:id/suspensions` | Suspend from a period start, optionally until another. |
| `POST` | `/contracts/:id/resume` | Set the resumption of the open suspension. |
| `POST` | `/contracts/:id/cancel` | Stop billing from a period start (a draft is simply discarded). |
| `POST` | `/contracts/:id/renewals` | Renew for the original term, with an optional readjustment in basis points. |
| `POST` | `/contracts/renewals` | Renew every self-renewing contract whose last period has begun; repeating it renews nothing twice. |
| `GET` | `/contracts/:id/billed-periods` | The periods billed so far, frozen, with their credit, receivable and NFS-e per line. |
| `POST` | `/contracts/:id/periods/:competence/bill` | Bill one period now, outside a run; refused with the reason it cannot be billed. |
| `POST` | `/contracts/:id/periods/:competence/credit` | Credit a billed period in full (`reasonCode` `not-provided` or `billing-error`, and a `reason`). |
| `POST` | `/billing-runs/preview` | What a run of a `competence` month would bill, skip and refuse, and why; writes nothing. |
| `POST` | `/billing-runs` | Run a month: renews due contracts, then bills contract by contract. The same key finds the same run and finishes what is pending. |
| `POST` | `/billing-runs/:id/resume` | Carry on with a run that stopped midway. |
| `GET` | `/billing-runs?competence=` | Recent runs with their totals. |
| `GET` | `/billing-runs/:id` | One run and what it did to each contract. |
| `GET` | `/contract-billing/overview` | Recent runs, and billed periods past the threshold (`CONTRACT_BILLING_GAP_SECONDS`, 3 days by default) without a posted receivable or an authorized NFS-e. |
| `GET` | `/shipments` | Every delivery on its way out, newest first: the warehouse's board. |
| `GET` | `/orders/:id/shipments` | Everything being picked, packed or gone for one order. |
| `GET` | `/shipments/:id` | Read one delivery and what is in it. |
| `POST` | `/shipments` | Pick goods for a customer; the quantities are held against the order. |
| `POST` | `/shipments/:id/pack` | Close the box, and name the carrier. |
| `POST` | `/shipments/:id/dispatch` | Send it: stock moves, and the delivery's share becomes owed. |
| `POST` | `/shipments/:id/return` | Record that the customer sent it back, with the reason. |
| `POST` | `/shipments/:id/abandon` | Undo a delivery that never left; its goods return to the order. |
| `GET` | `/orders` | List recent sales orders. |
| `GET` | `/orders/:id` | Read one order snapshot. |
| `POST` | `/orders` | Place an order and start the Inventory choreography. |

Every command that creates a document — a quote, a version of one, an order, a conversion,
a service order, a delivery, a contract, a billed period, a credit, a billing run — requires an `Idempotency-Key` header and runs at most once
under it (ADR 0028). A retry is recognised by its key and its body, whatever request id the
gateway gives it. A decision
on a document that already exists does not: repeating it is refused by the document's own
state.

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
