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

The RabbitMQ queue is durable and binds only the event types Fiscal consumes: the five Phase 39 types plus the Phase 44 Procurement order, receipt and return events and the Financial payable posted and reversed events. Parsing
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

### Supplier NF-e imports (Phase 44)

Set `FISCAL_INBOUND_SCHEMA_PATH` to the pinned PL 010f zip to enable `/imports`
(the local compose file mounts it). A `reviewer` or `admin` posts the raw XML. Fiscal
verifies it, keeps the bytes encrypted, and proposes the Procurement receipt lines it
covers. One reconciliation per import is committed with an `Idempotency-Key`. Imports
never create stock or payables ([ADR 0051](../docs/adr/0051-supplier-xml-is-evidence-not-an-operational-fact.md)).
For parties projected before Phase 44, run `npm run phase44:reindex-parties` with
`DATABASE_URL`, `FISCAL_ARTIFACT_KEY_HEX` and `TENANT_ID` to build the supplier tax-id
index. For simulation drills, `npm run phase44:supplier-invoice` writes a signed
homologation supplier NF-e with a throwaway certificate; it requires
`FISCAL_ALLOW_SUPPLIER_FIXTURE=true`. `scripts/phase44-smoke.mjs` runs the local-stack
smoke through Kong.

### Returns, complements and correction letters (Phase 45)

`POST /linked-origins` freezes a sale return (`shipmentId`), a purchase return
(`receiptId`, `establishmentId`) or a reviewed value complement, and conserves the
returned quantities against the original lines. The draft is created with
`POST /documents` and `origin.kind = 'linked'` and then follows the usual validate and
issue commands. `GET /documents/:id/links` shows references, linked documents and the
ids Inventory and Financial key their effects by. `GET /document-kinds` lists every kind
and why the unsupported ones are refused. `POST /documents/:id/correction-letters` queues
a model 55 correction letter; it needs the Phase 42 event schema path and credential.
Linked documents never create stock or money effects
([ADR 0052](../docs/adr/0052-returns-and-complements-are-linked-documents.md)).
`npm run phase45:rollout -- --tenant <id> --establishment <id> [--evidence-digest <sha256>]`
imports and reviews the Phase 45 rules and registers one capability per kind next to the
establishment's active sale. It prints the `linked` map for
`FISCAL_SIMULATION_PROFILE_JSON`. `scripts/phase45-smoke.mjs` runs the local-stack smoke
through Kong.

### NFC-e model 65 (Phase 46)

`POST /documents` with `model: '65'` (request version 2) turns a Sales intent into an
NFC-e draft. The first document of an intent fixes its model (`MODEL_CONFLICT`
otherwise). Readiness requires a final, non-contributor recipient in the issuer's UF and
an active `consumer-sale` capability. `src/nfce65/` builds the model 65 XML, the version 3
QR code, the signature placed after `infNFeSupl` and the 80 mm DANFE NFC-e. The worker
routes model 65 commands to `DeterministicNfce65Simulator`. Cancellation needs the
profile's `consumer.cancellationWindowMinutes`
([ADR 0053](../docs/adr/0053-nfce-is-a-separate-model-over-the-sales-shipment.md)).
`npm run phase46:rollout -- --tenant <id> --establishment <id> [--evidence-digest <sha256>]`
imports and reviews the model 65 rules and registers its capability next to the
establishment's active sale. It prints the `consumer` block for
`FISCAL_SIMULATION_PROFILE_JSON`. `scripts/phase46-smoke.mjs` runs the local-stack smoke
through Kong.

### National NFS-e (Phase 47)

A reviewer creates a service fiscal profile (`POST /service-profiles`: national tax
code, NBS, ISS treatment) for a Catalog service item. The municipal registry
(`POST /nfse-registry/versions`, then `/review`) records the reviewed rows of the official
adhesion list. `GET /nfse-registry/municipalities/{code}` says whether the national system
issues there. `POST /service-origins` freezes a service with its competence date; an
optional `sourceKey` maps one owner fact to one origin. `POST /service-documents` creates
the NFS-e draft, which follows `/service-documents/{id}/validate`, `/issue`,
`/status-queries`, `/cancellation-requests` (event 101101) and `/substitutions`
(event 105102). `src/nfse/` builds and signs the DPS, validates it against
`FISCAL_NFSE_SCHEMA_PATH` (the pinned XSD 1.01 ZIP), and routes `nfse` commands to
`DeterministicNfseSimulator`, which consults a DPS before any resend
([ADR 0054](../docs/adr/0054-national-nfse-is-keyed-by-municipality-and-reconciled-by-dps.md)).
`npm run phase47:rollout -- --tenant <id> --establishment <id> [--evidence-digest <sha256>]`
imports and reviews the registry version and the ISS and IBS/CBS rules of the issuer's
municipality and registers its capability. It prints the `service` block for
`FISCAL_SIMULATION_PROFILE_JSON`. `scripts/phase47-smoke.mjs` runs the local-stack smoke
through Kong.

### Operator reads, metrics and support (Phase 48)

- `GET /documents` is the operator worklist:
  - every model, newest first;
  - filters `status` and `model`, and a keyset `cursor`;
  - the pending command and the last rejection code of each document.
- `GET /support/overview` is the tenant's support snapshot:
  - queue, statuses and unknown outcomes;
  - rejection codes, certificates and imports;
  - undelivered events;
  - active capabilities of every model;
  - source-package age.
- `src/metrics.ts` exports gauges from those snapshots, summed over the tenants the
  worker serves. It also records authority outcomes, authorization latency, XML
  validation failures and object-store failures. No label names a tenant, document, key
  or party ([ADR 0055](../docs/adr/0055-fiscal-support-reads-metrics-and-bounded-replay.md)).
- The alert rules are in `infra/observability/rules/fiscal.rules.yml`; `make test-alerts`
  tests them.
- `npm run support -- <command>` (`dist/support-cli.js`) runs the bounded, audited
  support commands:
  - `overview`;
  - `reconcile-unknown`;
  - `retry-due`;
  - `replay-outbox`, which goes through `fiscal_outbox_replays`, so a delivered event is
    republished under its own id.

  See the [operations runbook](../docs/fiscal-operations-runbook.md).

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
