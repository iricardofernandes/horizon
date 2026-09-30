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

### Services delivered in Sales (Phase 50)

The ingress records one intake per line of `sales.service.delivered`, keyed by its
`entryId`. The worker cycle then turns each intake into a service origin with `sourceKey`
`sales` / `service-delivery` / entry id / competence month, and a draft. It resolves the
issuer and recipient revisions in force today and the service profile in force at the
competence date, and picks the one establishment with an active NFS-e capability in the
issuer's municipality. Each establishment's policy (`GET`/`PUT
/service-issuance-policies/{establishmentId}`: `review`, the default, or `automatic`, and
the DPS series) decides whether the draft waits for a person or is validated and issued.
An intake that cannot proceed is `blocked` with its reason and retried with backoff;
`POST /service-intakes/{id}/retry` asks for it now, and `GET /service-intakes?status=`
lists them. `sales.service.delivery-cancelled` withdraws the intake:
- an authorized NFS-e gets event 101101 with reason 2;
- outside the window the intake is `cancellation-refused`;
- a draft is withdrawn, and issuance refuses it from then on.

`scripts/phase50-smoke.mjs` runs the services smoke through Kong.

### Contract periods billed in Sales (Phase 52)

`sales.contract-period.billed` is worked exactly like a delivery. Each billed line is one
intake, with `sourceKey` `sales` / `contract-period` / entry id / competence month and the
first day of the period as the competence date. The intake names `billedPeriodId` and
`contractId` instead of `deliveryId` and `serviceOrderId`.

`sales.contract-period.credited` withdraws the intakes of the period. The cancellation
takes reason 2 when the service was not provided and reason 1 when it was billed in error.

`GET /service-intakes` filters by `documentType` (`service-delivery` or `contract-period`)
and `period`, so the intakes of one billing month can be listed. The gauges
`fiscal_service_intakes_blocked` and `fiscal_service_intakes_cancellation_refused` feed the
alerts `FiscalServiceIntakesBlocked` and `FiscalServiceCancellationRefused`.

`scripts/phase52-smoke.mjs` runs the billing smoke through Kong.

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

## The tax rule catalogue (Phase 82)

Tax law lives in a catalogue that every workspace reads and none writes (ADR 0070). The
tables are `fiscal_catalog_packages`, `fiscal_catalog_references` and
`fiscal_catalog_rules`. A workspace adopts a package version from a date, and keeps its own
rows only for what is its own. `npm run phase82:catalog -- <action>`:

| Action | Role | What it does |
|---|---|---|
| `publish-phase41 --artifact <calculadora.zip>` | `DATABASE_MIGRATION_URL` | Publishes Phase 41's approved package with its original identifiers |
| `retire-copy --tenant <id> --actor <who>` | `DATABASE_URL` | Deactivates the workspace's own copy of a published package |
| `adopt --tenant <id> --effective-from <date> --reviewed-by <who> --actor <who>` | `DATABASE_URL` | Adopts a package; refused while an active own rule would tie with it |
| `verify --fixture <file>` | `DATABASE_URL` | Previews a fixture and requires its approved result |
| `verify-lock --tenant <id> --document <id>` | `DATABASE_URL` | Replays a locked calculation and prints its digests |

`verify` and `verify-lock` also need `FISCAL_ARTIFACT_KEY_HEX`. See the
[Phase 82 evidence](../docs/tax-phase82-evidence.md).

### Formulas (Phase 83)

A rule with `formula: "EXPRESSION"` carries
`expression: { "version": "formula-v1", "base": <node>, "outcome": "levied" }`. The amount
is `round(round(base) × rate)`, with the rule's rate. The nodes are:
- `{ "line": "gross" | "discount" | "charges" | "net" | "quantity" }`;
- `{ "component": "<CODE>" }`;
- `{ "rate": { numerator, denominator } }`;
- `sum`, `product`, `min` and `max` (2 to 8 operands);
- `{ "grossUp": { base, rate } }` and `{ "reduce": { base, by } }`.

Outcomes are `levied`, `exempt`, `suspended`, `deferred` and `not-levied`. Cycles, unknown
components and trees deeper than 8 or larger than 64 nodes are refused when a package is
imported or published (ADR 0071).

A formula may name its rounding: `"rounding": "half-even"` rounds the base and the amount half
to even, as the official IBS/CBS calculator does. Without it, rounding is half away from zero,
as Phase 41's rules are.

### IBS and CBS by tax classification (Phase 84)

A calculation line may carry `classifications.classTrib`, the six-digit `cClassTrib`, and a
rule may be scoped by it (`class_trib`). The 2026 package is built from the official
calculator's own database and checked against the calculator itself (ADR 0072):

```bash
make tax-oracle             # DOWNLOAD=1 fetches the calculator; refused unless its digest is pinned
npm run phase84:oracle -- build --database <calculadora-pro.db> --artifact <calculadora.zip> --out <package.json> [--hypothetical-2027]
npm run phase84:oracle -- oracle --package <package.json> --database <db> --url http://127.0.0.1:18080 --out <report.json> [--cases 3000] [--seed 84]
npm run phase84:oracle -- publish --package <package.json>    # DATABASE_MIGRATION_URL; never a hypothetical one
```

The oracle fails on any difference, any refusal and any class of the package without an
agreeing case. A workspace adopts the package with `phase82:catalog adopt --package <id>`.
Lines without a classification, and Phase 41's operation, keep their own rules. See the
[Phase 84 evidence](../docs/tax-phase84-evidence.md).

### The legacy taxes and the support matrix (Phase 85)

Rules can also be scoped by `recipientTaxpayer`, `issuerMunicipality` and one `fact` of the
line's `taxFacts` (`ipiTaxpayer`, `destinationUse`). Formulas gain `difference` and
`deduct`. The declared scenarios, and the steps that take them from package to adoption:

```bash
npm run phase85:scenarios -- fixtures            # build fixtures; an unchanged one keeps its approval
npm run phase85:scenarios -- approve --fixture <id> --by <who> --scope <text>   # only on the owner's word
npm run phase85:scenarios -- publish             # DATABASE_MIGRATION_URL
npm run phase85:scenarios -- adopt --tenant <id> --actor <who>
npm run phase85:scenarios -- verify              # DATABASE_URL, FISCAL_ARTIFACT_KEY_HEX
npm run phase85:scenarios -- matrix              # regenerate support-matrix.json from the evidence
```

`GET /fiscal/support` returns the matrix. Given `model`, `date`, `tax`, one of `ncm`,
`service` or `classTrib`, and optionally the states, `recipientTaxpayer`,
`issuerRegime`, `issuerMunicipality`, `origin` and `fact.<key>=<value>`, it answers
`supported` with the rows that cover the scenario, or `unsupported` with the missing
dimension. See the [Phase 85 evidence](../docs/tax-phase85-evidence.md).

### Regimes and the blend (Phase 86)

`issuer.regime` is the NF-e's CRT (`normal`, `simples-nacional`, `mei`), and
`issuer.incomeTaxRegime` (`lucro-real`, `lucro-presumido`) decides PIS/Cofins. Both come from
the issuer profile revision in force on the issue date (`issuer-regime.ts`). A package may
name components it reads from others (`requires`). The reviewed scenarios of both phases:

```bash
npm run tax:scenarios -- fixtures --phase 86     # phase85:scenarios is the same with --phase 85
npm run tax:scenarios -- approve --phase 86 --fixture <id> --by <who> --scope <text>
npm run tax:scenarios -- publish --phase 86      # then adopt, verify; matrix reads every phase
```

See the [Phase 86 evidence](../docs/tax-phase86-evidence.md).

## Audit log (Phase 68)

`GET /audit` reads the tenant's hash-chained log a page at a time, newest first, filtered
by actor, action, record and period. Every page carries the chain's verdict: each row is
recomputed and checked against its neighbours, so a tampered row reads as broken. Read by
admins; the web's audit screen asks it alongside every other module.
