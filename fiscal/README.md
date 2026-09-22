# Fiscal — Phase 40 independent service and durable records

This module owns fiscal intents and its own encrypted copies of issuer and recipient
profiles. It listens only to `sales.fiscal-origin.recorded`, the dedicated owner profile
notices, catalog classification notices and party erasure. A Sales delivery or return
creates one intent keyed by `(tenant, module, document type, document id, purpose)`.
The intent remains `blocked_profile` until its owner profiles are reconciled. Fiscal
stores the exact Sales origin payload encrypted, creates immutable simulation drafts
from that payload, and reserves numbers concurrently within a tenant and series. The
read API exposes document status and artifacts only to the owning tenant. The worker
does not calculate tax, contact an external authority or create a stock or financial
effect. Every authority capability remains `unsupported`; public validation, issuance
and cancellation requests return a conflict. A reserved number is never silently
reused after a timeout or restart.

## Run locally

The database needs separate `horizon_owner` migration and `horizon_app` runtime roles.
The application role has no `BYPASSRLS`; the migration grants only the required tables.

1. Install the pinned contracts package and other dependencies with `npm ci`.
2. Set `DATABASE_MIGRATION_URL` and run `npm run db:migrate`.
3. Set the variables in `.env.example`, including a 32-byte artifact encryption key and
   an S3-compatible artifact bucket, then run `npm run build` and `npm start`.
4. Create tenant-scoped Identity API keys with `parties:read`, `identity:read` and
   `catalog:read` scopes. Their issuer needs `parties:fiscal-reader`,
   `identity:fiscal-reader` and `catalog:viewer`. Supply the worker a secret
   `FISCAL_SERVICE_KEYS_JSON` map before processing that tenant's profile notices. The
   service can start with an empty map for onboarding, but cannot project profiles for
   that tenant until its key is provisioned. It exchanges each key for a short token through
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

The API listens on port 3011. It verifies Identity JWTs and revocation, applies Fiscal
`admin`, `issuer`, `reviewer` and `viewer` permissions, and provides `/health`,
`/capabilities`, `POST /documents`, `GET /documents/:id` and tenant-scoped artifact
reads. Creating a draft requires an `Idempotency-Key` and a captured Sales origin.
Old Phase 39 intents without an encrypted origin payload need the owner event replayed
with a new event ID before draft creation. The request cannot supply replacement
commercial facts. Simulation submission and cancellation are internal persistence
operations used to prove crash recovery; they are not public authority operations.

## Verification

`npm run test:e2e` starts PostgreSQL, RabbitMQ and MinIO with Testcontainers. It runs the
real migration under a non-superuser owner role, checks broker duplicate delivery,
origin uniqueness, encrypted revisions, erasure, owner-API backfill resume and tenant
isolation. It also checks duplicate drafts, audit integrity, cross-tenant draft and
artifact rejection, concurrent number reservation, uncertain authority outcomes,
process restart, encrypted artifact recovery and object version restore. The package
also passes `npm run typecheck`, `npm run lint` and `npm run build`.

Issuance remains unavailable for every tuple in
[the capability matrix](../docs/fiscal-capabilities.md). The
[Phase 40 evidence record](../docs/fiscal-phase40-evidence.md) maps implementation and
verification to the phase exit criteria.
