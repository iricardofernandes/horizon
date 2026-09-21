# Fiscal — Phase 39 ingress and projections

This module owns fiscal intents and its own encrypted copies of issuer and recipient
profiles. It listens only to `sales.fiscal-origin.recorded`, the dedicated owner profile
notices, catalog classification notices and party erasure. A Sales delivery or return
creates one intent keyed by `(tenant, module, document type, document id, purpose)`.
The intent remains `blocked_profile`: this module does not choose tax rules, allocate a
fiscal number, send a document to an authority or create a stock or financial effect.
Those lifecycles start in later phases under an enabled capability row.

## Run locally

The database needs separate `horizon_owner` migration and `horizon_app` runtime roles.
The application role has no `BYPASSRLS`; the migration grants only the required tables.

1. Install the pinned contracts package and other dependencies with `npm ci`.
2. Set `DATABASE_MIGRATION_URL` and run `npm run db:migrate`.
3. Set the variables in `.env.example`, then run `npm run build` and `npm start`.
4. Create tenant-scoped Identity API keys with `parties:read`, `identity:read` and
   `catalog:read` scopes. Their issuer needs `parties:fiscal-reader`,
   `identity:fiscal-reader` and `catalog:viewer`. Supply the worker a secret
   `FISCAL_SERVICE_KEYS_JSON` map. It exchanges each key for a short token through
   Identity and refreshes it before expiry. Tokens and keys never enter events or logs.
5. For a tenant, set `TENANT_ID` and `FISCAL_SERVICE_API_KEY`, then run
   `npm run backfill`. The command outputs only
   source counts, committed checkpoint and projection counts, and rolling SHA-256
   digests of IDs and revision numbers. It fails on a missing or inconsistent checkpoint.

The owner APIs page IDs and revisions, then return exact historical versions only to
the restricted token. The backfill checkpoints after each page and may be rerun; a
failed page is fetched again without duplicating a revision. A changed revision under
the same ID raises a conflict for review. Existing Parties or Catalog rows at revision
zero remain incomplete until their owners verify and classify them. No city name,
address or tax code is guessed from legacy free text.

The RabbitMQ queue is durable and binds only the five Phase 39 event types. Parsing
failures are dead-lettered; handler failures get one broker redelivery. The inbox and
origin constraint protect separate retry paths. A missing or stale owner profile cannot
authorize an intent. Party erasure destroys Fiscal's subject key, including when the
erasure arrives before a delayed projection. The retained ciphertext is then unreadable.

## Verification

`npm run test:e2e` starts PostgreSQL and RabbitMQ with Testcontainers. It runs the
real migration under a non-superuser owner role, checks broker duplicate delivery,
origin uniqueness, encrypted revisions, erasure, owner-API backfill resume and tenant
isolation. `npm run typecheck`, `npm run lint` and `npm run build` check the package.

Issuance remains unavailable for every tuple in
[the capability matrix](../docs/fiscal-capabilities.md). The authority adapters,
document artifacts, certificate handling, audit chain and HTTP operator API belong to
the independent service lifecycle in Phase 40 and later phases.
