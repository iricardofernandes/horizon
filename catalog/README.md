# `catalog/`

Products, services, units of measure, price lists and NCM classification.

An independently deployable NestJS service with its own database, its own container
and its own lifecycle. It is reached through Kong, never directly, and it shares no
source with any other module (ADR 0001).

**Status: phase 6 — complete.** The domain, use cases, tenant-scoped persistence, outbox
relay, AMQP consumer, authenticated HTTP surface and audit chain are real and tested. A
PostgreSQL e2e exercise also proves the complete expand/contract sequence that this module
adds to the reusable [pattern set](../docs/patterns/zero-downtime-migration.md).

---

## What this context owns

- **Products and services** — the sellable and purchasable item master.
- **Units of measure** and the conversion factors between them.
- **Price lists** — versioned, with validity intervals, per tenant.
- **NCM classification** — the fiscal classification code carried by an item (see `docs/glossary.md`).

## What it explicitly does not own

This list matters more than the one above — a bounded context is defined by its
refusals.

- **Stock.** How many exist and where is `inventory/`. Catalog defines *what* a thing is, never *how many*.
- **The price actually charged.** `sales/` snapshots a price onto an order line at confirmation, because a later price-list change must not alter a historical order.
- **Tax rules.** NCM is stored here as a classification; what it implies for tax is `fiscal/` (roadmap).
- **Suppliers and purchasing.** Not in scope.

---

## Events

### Published

| Event | Meaning |
|---|---|
| `catalog.item.created` | A product or service exists and may be ordered or stocked. |
| `catalog.item.deactivated` | The item may no longer be added to new documents; existing ones are unaffected. |
| `catalog.price.changed` | The current amount for an item in a price list changed; order snapshots are unaffected. |

### Consumed

| Event | Reaction |
|---|---|
| `identity.tenant.created` | Creates the tenant's default units — `UN`, `KG`, `L`, `H` — and an empty base price list in `DEFAULT_PRICE_LIST_CURRENCY`. |

Consumption is bounded and explicit: a durable `catalog.events` queue, prefetch from
`AMQP_PREFETCH`, and a dead-letter exchange behind it. A message this module cannot
understand — malformed, or an event type and version it holds no contract for — is
dead-lettered on arrival rather than redelivered into a loop. A handler that throws gets
exactly one immediate retry and is then dead-lettered, which covers a database blip
without hiding a persistent bug. `catalog.events.dlq` is the queue a human looks at;
nothing is discarded.

Every published event is written to the `outbox` table inside the same transaction as
the state change it describes, and relayed by a poller using `FOR UPDATE SKIP LOCKED`
(ADR 0024). Delivery is at-least-once, so every consumer deduplicates against an
`inbox` table keyed on `(source_module, event_id)`.

Schemas live in `@horizon/contracts` and are versioned there (ADR 0030); this module
does not define its own wire shapes.

---

## Endpoints

Reached through Kong, never directly. OpenAPI is generated from the controllers and the
same Zod schemas that validate the request, and served at `/docs`.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/units` | `read:Units` | List units of measure, keyset-paginated. |
| `POST` | `/units` | `manage:Units` | Define a unit of measure. |
| `GET` | `/items` | `read:Items` | List products and services, keyset-paginated. |
| `POST` | `/items` | `manage:Items` | Add a product or service. |
| `PATCH` | `/items/{itemId}/deactivate` | `manage:Items` | Stop the item being added to new documents. Existing references stay valid. |
| `GET` | `/price-lists` | `read:PriceLists` | List price lists with their current prices. |
| `POST` | `/price-lists` | `manage:PriceLists` | Create a price list in one currency. |
| `PUT` | `/price-lists/{priceListId}/prices/{itemId}` | `manage:Prices` | Set the current price of an item. |
| `GET` | `/health/live` | public | Is the process running. |
| `GET` | `/health/ready` | public | Are PostgreSQL and Redis reachable. |

Writes accept an optional `Idempotency-Key` (ADR 0028): a repeat of the same request
replays the stored response, and the same key with a different body is a `409`.

### Authorization

The bearer token is verified here against Identity's published keys — `EdDSA` only, the
issuer bound to the token's own `kid` — so reaching this service's port directly grants
nothing (ADR 0008). **The tenant comes from the `tenant_id` claim; a request header that
says otherwise is ignored.**

Identity stores `{ module, role }` pairs and cannot expand them. What a role *means* is
decided here (ADR 0023), so an `identity` owner or a `sales` admin has no access at all:

| Role | May |
|---|---|
| `viewer` | Read units, items and price lists. |
| `editor` | Everything `viewer` may, plus add and deactivate items and set prices. |
| `admin` | Everything, including defining units of measure and creating price lists. |

The split is structure versus contents: reshaping the catalogue is administrative, filling
it is daily work.

Revocation is checked against the denylist Identity writes (ADR 0021). While that store is
unreachable, list endpoints — and only those, declared per handler and visible in OpenAPI
as `x-revocation-store-outage` — continue to answer; every write is refused with `503`.

---

## Audit

Every write appends a link to the tenant's hash chain in the same transaction as the
change itself (ADR 0025), recording who acted, on what, before and after, and the request
and trace identifiers that tie the entry to a log line and to a span.

```bash
DATABASE_URL=… npm run audit:verify -- <tenant-uuid>
```

The command walks the chain in bounded batches and prints a verdict; it exits non-zero and
names the **first** sequence that does not match, because "the log is invalid" is not an
actionable answer while "intact through 40,912; entry 40,913 does not match" is. Editing a
row or removing one from the middle both break it — the successor's `previous_hash` stops
matching its predecessor.

Append-only is enforced twice in the database: the application role holds no `UPDATE` or
`DELETE` on the table, and a trigger raises on `UPDATE`, `DELETE` and `TRUNCATE` so the
prohibition survives a careless `GRANT`. Appends serialize on a per-tenant advisory lock,
so eight concurrent writers produce eight consecutive links rather than a fork.

**What it does not promise.** A privileged operator who deletes the entire tail leaves a
shorter chain that still verifies. Detecting that needs a checkpoint stored where this
database cannot reach; Catalog does not have one, and says so rather than implying the
chain is proof against its own administrator. Catalog also stores no personal data, so
unlike Identity nothing here is encrypted under a data-subject key or redacted before
hashing — the `redacted` member is part of the hashed payload anyway, so that redaction
can begin later without changing the format of a chain that already exists.

---

## Running it locally

The platform (PostgreSQL, Redis, RabbitMQ, Kong, the observability plane) comes up with
`make up` at the repository root. Through the gateway this module lives under `/catalog`;
reaching its port directly still requires a valid token.

```bash
npm install          # or npm ci
cp .env.example .env # fill in; the process refuses to start on invalid config

npm run typecheck    # tsc --noEmit, strict plus the three extra flags
npm run lint         # biome check
npm test             # unit tests: no I/O, in-memory fakes
npm run dev          # http://localhost:3002, OpenAPI at /docs
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

Schema changes to populated tables follow the expand/contract recipe rather than making a
rename or new invariant atomic with an application deploy. The executable price-list
exercise covers an old and a new writer in the same compatibility window, bounded
backfill, validated cutover and removal of the old column; see
[`zero-downtime-migration.md`](../docs/patterns/zero-downtime-migration.md).

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

Some settings below are reserved for something Catalog has not built yet —
`INBOX_RETENTION_DAYS` waits for the retention sweep, `HTTP_CLIENT_TIMEOUT_MS` and the two
`CIRCUIT_BREAKER_*` values for the first outbound call — and are deliberately not
validated at boot, because validating a setting nothing honours would be a claim that it
does something. `TRUST_GATEWAY_JWT=true` is rejected. `DATABASE_RELAY_URL` is optional:
without it this process serves HTTP and does not relay.

| `NODE_ENV` | — |
| `PORT` | HTTP port. Behind Kong in every environment; exposed directly only in local development. |
| `LOG_LEVEL` | pino level. `info` in production. |
| `DATABASE_URL` | Application role. Holds neither SUPERUSER nor BYPASSRLS, so RLS applies to it (ADR 0017). |
| `DATABASE_MIGRATION_URL` | Owner role, used only by `db:migrate`. The application never connects with it. |
| `DATABASE_POOL_MAX` | Bulkhead: the pool this service may consume (ADR 0027). |
| `DATABASE_RELAY_URL` | Separate relay role, granted access only to `outbox`. Omit to disable the local relay. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | No query waits without a bound. |
| `REDIS_URL` | Denylist, idempotency records, rate counters. |
| `RABBITMQ_URL` | — |
| `AMQP_PREFETCH` | Bounded consumer concurrency (ADR 0027). |
| `DEFAULT_PRICE_LIST_CURRENCY` | The currency a new tenant's base price list is created in. |
| `OUTBOX_POLL_INTERVAL_MS` | Relay poll interval; the floor on publish latency (ADR 0024). |
| `OUTBOX_BATCH_SIZE` | Rows claimed per poll with FOR UPDATE SKIP LOCKED. |
| `INBOX_RETENTION_DAYS` | Must exceed the maximum possible redelivery window. |
| `IDEMPOTENCY_TTL_SECONDS` | 24 hours (ADR 0028). |
| `IDEMPOTENCY_SECRET` | Keys the idempotency record scope and encrypts its cached response body. At least 32 characters. |
| `HTTP_CLIENT_TIMEOUT_MS` | Every outbound HTTP call. There is no unbounded wait anywhere. |
| `CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENT` | — |
| `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` | How long the breaker stays open before half-open probing. |
| `JWKS_URL` | Identity's public keys, for local token re-verification. |
| `ACCESS_TOKEN_MAX_AGE_SECONDS` | The oldest token this service accepts, independent of the lifetime Identity issues. |
| `TRUST_GATEWAY_JWT` | When false the service re-verifies every token itself, so reaching its port directly grants nothing (ADR 0008). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The Collector. Nothing talks to a backend directly (ADR 0033). |
| `OTEL_SERVICE_NAME` | — |
| `OTEL_TRACES_SAMPLER_ARG` | Full sampling locally; errors are always sampled. |
| `TENANT_ID_HASH_SALT` | Tenant ids are hashed before appearing in logs and metrics (ADR 0033). |

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
