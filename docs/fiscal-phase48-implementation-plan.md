# Phase 48 — Operator screens, rollout and support evidence

Status: **delivered for simulation on 2026-09-26**
([evidence](fiscal-phase48-evidence.md)). This is the execution record for
[Phase 48 in the fiscal roadmap](fiscal-implementation-plan.md#48--operator-screens-rollout-and-support-evidence).
The environment is still simulation-only. Every authority in this phase is a
deterministic simulator or the emulated SEFAZ of Phase 43; no official endpoint is
contacted, and no homologation or production row is enabled.

## Result

Phases 41–47 delivered Fiscal as an API. Phase 48 makes it operable by a person and
supportable by an operator:

- **Fiscal screens** in the web shell, in `pt-BR` and `en`, for the whole workflow:
  - a worklist of issued documents (NF-e 55, NFC-e 65 and NFS-e) with filters;
  - a document view with its status timeline, the locked calculation and its
    explanation, authority errors, artifacts to download, links to related documents,
    and the permitted actions: validate, issue, consult, cancel, correction letter and
    NFS-e substitution;
  - a rule preview that explains a calculation before any document exists;
  - supplier XML import, review, matching and conflict dismissal;
  - a support page: queue lag, unknown outcomes, rejection codes, certificate expiry,
    unmatched imports, undelivered events, source-package age and the capability matrix.

  Every simulated document is labelled "Simulação — sem valor fiscal" / "Simulation —
  no fiscal value". The product never calls one authorized without that label.
- **Metrics and alerts** for queue lag, authorization latency, unknown outcomes,
  rejection codes, certificate expiry, XML validation failures, unmatched imports,
  object-store failures and source-package age, with Prometheus alert rules tested by
  `promtool`.
- **Bounded support commands** that cannot duplicate a business effect: consult
  documents in an unknown state, bring forward due retries, and republish undelivered or
  selected outbox events.
- **A golden path** against the local stack: quote → order → fiscal authorization →
  permitted dispatch → stock and receivable, and supplier XML → receipt → payable match.
- **Support documentation**: a published support matrix with evidence dates, an
  operations runbook (alerts, replay, reconciliation, certificate rotation, artifact
  restore, retention), a threat model, and the glossary and API docs.

## Starting point

- The web shell (Next.js 16, next-intl, `web/src/lib/navigation.ts`) has no Fiscal
  group. The only Fiscal UI is the certificate upload panel on the workspace page. The
  demo user already holds `fiscal:admin`, and the web proxy already forwards `/fiscal`.
- Fiscal exposes reads for one document (v1/v2/v3), its timeline, calculation,
  explanation, artifacts and links, and for supplier imports (list and detail). There is
  **no list of issued documents** and no support read.
- Fiscal exports OpenTelemetry through the Collector (ADR 0033), but it records **no
  domain metric**. Prometheus has no rule file.
- The worker runs one cycle per second for every tenant in `FISCAL_SERVICE_KEYS_JSON`.
  Retries are already consultation-first: an uncertain issuance or cancellation is
  consulted before any resend (Phases 42, 46, 47).
- The rejection code of a simulated rejection is only kept in the outbox payload
  (`rejectionCode`).
- Smoke scripts exist per phase (41–47) and exercise the API through Kong. The browser
  golden path (`web/scripts/golden-path.e2e.mjs`) covers login, Catalog and Sales, but
  no Fiscal screen.

## Decisions frozen by this plan

1. **Screens read the API, never the database.** Two new reads are added to Fiscal, and
   both are additive in contracts 0.37.0:
   - `GET /fiscal/documents` lists documents of every model, with keyset pagination
     (`createdAt`, `id`), filters by status and model, and the pending command and last
     rejection code per document.
   - `GET /fiscal/support/overview` returns the tenant's support snapshot.
2. **Metrics never carry a tenant, document, key or party label.** A metric is an
   aggregate over the tenants the worker serves. Labels are limited to bounded values:
   model, outcome, rejection code (from a fixed list, otherwise `other`), artifact kind
   and command kind. Per-tenant detail stays behind the authenticated support read.
3. **Alerts describe symptoms, and the runbook names the action.** Every alert rule
   has a runbook anchor. Thresholds are local defaults, documented as a deployment
   owner's decision.
4. **Support commands reuse the existing idempotent paths.**
   - Reconciliation enqueues the same status query an operator can request; the worker
     still consults before any resend.
   - Bringing a retry forward only changes `next_attempt_at` of a pending job.
   - Replay clears `delivered_at` of outbox rows; consumers deduplicate by event id.

   Every command is bounded (at most 100 rows), writes an audit entry and prints what
   it changed. None can create a document, a number or an effect.
5. **Actions appear only when the role and status allow them.** The server still
   decides (ADR 0023, ADR 0045). An action the server refuses shows its problem detail
   and stable code, never a guessed state.
6. **The support matrix is generated from evidence, not typed.** The published matrix
   gains an evidence-date column. A row enabled in homologation or production would need
   its own homologation suite. No such row exists, so the homologation part of the exit
   gate is empty, and the evidence says so.
7. **Retention is not invented.** The runbook states what is kept (original XML,
   authority evidence and linked events are append-only), where it is kept, and that the
   legal retention period is set and verified by the deployment owner.

## Work

### A — Fiscal reads, metrics and support commands

1. `fiscal/src/document-list.ts`: the tenant-scoped document list. It covers all
   models, joins the number reservation, the NFS-e generation, the pending dispatch job
   and the last rejection code from the outbox, and uses keyset pagination.
2. `fiscal/src/support.ts`: the tenant support snapshot:
   - dispatch queue (pending and leased, oldest due age, highest attempt count);
   - document counts by status, and unknown outcomes;
   - rejection codes over the last 7 days;
   - certificates with days remaining;
   - unmatched and conflicting imports;
   - undelivered outbox events and their oldest age;
   - the age of each source package.
3. `fiscal/src/metrics.ts` (OpenTelemetry meter `fiscal.support`):
   - observable gauges from the snapshot summed over the served tenants;
   - authorization latency histogram and outcome counter recorded by the issue worker;
   - XML validation failure counter;
   - object-store failure counter.
4. Routes `GET /documents` and `GET /support/overview` (permission `read`), with
   contracts 0.37.0 (`fiscalDocumentSummarySchema`, `fiscalDocumentListSchema`,
   `fiscalSupportOverviewSchema`).
5. `fiscal/src/support-cli.ts`: the three commands `reconcile-unknown`,
   `retry-due` and `replay-outbox`, each bounded, audited and printed as JSON.
6. `infra/observability/rules/fiscal-alerts.yml`, loaded by Prometheus, and
   `fiscal-alerts.test.yml`, run by `promtool test rules`.

### B — Web screens

1. Navigation group `fiscal` (module `fiscal`) with four entries:
   - `/app/fiscal/documents`: the worklist and the document dialog;
   - `/app/fiscal/preview`: the rule preview;
   - `/app/fiscal/inbound`: supplier XML;
   - `/app/fiscal/support`: the support page and the capability matrix.
2. `web/src/features/fiscal/`:
   - pure helpers with unit tests: status tone, allowed actions per role, model and
     status, the simulation label, certificate expiry state, and the preview input
     builder;
   - views that follow the existing pattern (`useLoader`, `Resource`, `Board`,
     dialogs).
3. The certificate panel shows the expiry state (valid, expiring within 30 days,
   expired).
4. `messages/pt-BR.json` and `messages/en.json` get a `fiscal` namespace. Machine values
   stay in English (ADR 0044), and the key-parity test covers the new keys.

### C — Golden path and browser workflow

1. `scripts/phase48-golden-path.mjs` runs against the local stack:
   - quote → order → fiscal authorization → permitted dispatch; then Inventory shows
     the stock movement and Financial the receivable for that shipment, exactly once;
   - supplier XML → import → receipt → reconciliation → payable match;
   - replaying the outbox leaves those counts unchanged.
2. `web/scripts/fiscal-workflow.e2e.mjs` (Playwright, Chromium) runs in `pt-BR` and
   `en`. It covers:
   - the worklist, the document dialog with the simulation label, the timeline and
     the explanation;
   - an artifact download with a digest check;
   - an inbound import through the upload form;
   - the rule preview;
   - the support page.

### D — Documentation and evidence

1. `docs/fiscal-operations-runbook.md`:
   - one section per alert;
   - the support commands;
   - certificate rotation;
   - artifact restore;
   - backups;
   - retention.
2. `docs/fiscal-threat-model.md`: assets, trust boundaries, threats and the control and
   test for each.
3. ADR 0055: support reads, metrics without tenant labels, and bounded replay.
4. Also updated:
   - glossary;
   - `fiscal-capabilities.md` (evidence-date column);
   - `fiscal-implementation-plan.md`, `plan.md` and `fiscal/README.md`;
   - the evidence record `fiscal-phase48-evidence.md`.

## Exit evidence

| Roadmap criterion | Evidence planned |
|---|---|
| `make check`, module isolation | `make check`, `check-boundaries` |
| Real PostgreSQL/RabbitMQ crash and cross-tenant suites | fiscal e2e suite: all earlier suites plus the new document-list, support and replay tests, including cross-tenant reads |
| Golden path | `scripts/phase48-golden-path.mjs` on the local stack (three runs) |
| Browser workflows | `web/scripts/fiscal-workflow.e2e.mjs` in `pt-BR` and `en` |
| Artifact restore | restore check over artifacts of models 55, 65 and NFS-e, with byte digests and a cross-tenant refusal |
| Every enabled homologation matrix row | none enabled; the published matrix shows it |
| Never call a simulated document authorized, never advertise an untested jurisdiction | UI helper test and browser assertion of the simulation label; the matrix lists only evidenced rows |

## Out of scope

- Live homologation or production: this still needs the company A1, the official WSDL
  and Swagger, and fiscal review.
- A Grafana alert channel (e-mail or chat). Rules are evaluated by Prometheus and
  visible in its UI.
- New document models, operations or municipalities.
- Phase K contracts.

## Changes made during implementation

- **Capabilities in the support overview.** `/capabilities/v2` lists only NF-e 55 rows,
  so the support page could not show the NFC-e and NFS-e tuples. The overview gained a
  `capabilities` list of every active row (contracts 0.37.0, before its first commit).
- **Replay through a request table.** The outbox delivery guard (migration 0024) forbids
  clearing `delivered_at`. Replay is therefore an audited row in `fiscal_outbox_replays`
  that the relay publishes under the same event id.
- **Golden path order.** In simulation, the Sales fiscal origin is created at dispatch;
  a dispatch policy that waits for authorization requires a production authorization.
  The golden path dispatches, then authorizes the NF-e, and proves that authorization
  adds no effect. The production gate stays covered by the Sales tests of Phase 43.
- **Browser user.** The worker serves the "Phase 39 validation" tenant, whose only user
  had no Fiscal role. A fiscal operator was created there through the Identity API for
  the browser workflow (local preparation, recorded in the evidence).
- **Isolated broker for the restore drill.** A separate RabbitMQ container could not start
  on this host (Erlang cookie permission). The restored Fiscal uses its own vhost on the
  local broker instead, which shares no queue with the live one.
