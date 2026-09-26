# 55. Fiscal support reads the API, measures without tenants and replays within bounds

- Status: accepted and implemented locally; exercised in simulation
- Date: 2026-09-26

## Context

Phases 41–47 built Fiscal as an API: documents of three models, supplier XML, linked
documents and the national NFS-e. Phase 48 makes it operable by a person and supportable
by an operator. That raises three questions the earlier phases did not have to answer:

- **Screens need reads that do not exist.** There is a read for one document, but no
  list of documents and no summary of what is waiting, uncertain or about to expire.
- **Support needs metrics, but Fiscal is multi-tenant.** Queue lag, unknown outcomes and
  certificate expiry are per tenant, and a tenant id, access key or tax id in a metric
  label would leak into Prometheus, Grafana and every alert.
- **Support needs repair commands that cannot make things worse.** A consultation that
  got lost, a retry waiting on a long backoff, or an event a consumer must see again. The
  outbox row of a delivered event is immutable (migration 0024).

## Decision

- **Screens read the API, never a database.** Two additive reads:
  - `GET /fiscal/documents` is the operator worklist. It covers every model, has keyset
    pagination and filters, and shows the pending command and last rejection code.
  - `GET /fiscal/support/overview` is the tenant's support snapshot: queue, statuses,
    unknown outcomes, rejection codes, certificates, imports, outbox, active
    capabilities and source-package age.

  Both answer with counts, ages and identifiers of Fiscal's own records only, with no
  access key, tax id, party or XML.
- **Metrics are aggregates without tenants.** The worker sums the snapshots of the
  tenants it serves into observable gauges, refreshed on an interval so a scrape never
  waits on the database. Counters and one histogram are recorded where events happen:
  authority outcome and latency, XML validation failure and object-store failure.
  - Labels are bounded values only: model, command family, outcome, schema family,
    operation, and a rejection code that must look like an authority code (anything else
    is `other`).
  - Detail per tenant stays behind the authenticated support read.
- **Alerts describe a symptom; the runbook names the action.**
  - Prometheus loads `infra/observability/rules/fiscal.rules.yml`, and each rule links an
    anchor of the operations runbook.
  - The rules aggregate with `max`/`sum`, because resource labels change when the
    process restarts.
  - `promtool test rules` checks them (`make test-alerts`).
- **Repair commands reuse idempotent paths and are bounded.** `support-cli` has three
  commands:
  - `reconcile-unknown` queues the same consultation an operator can request, for
    documents whose outcome is unknown and that have nothing pending. The idempotency
    key comes from the document's last transition.
  - `retry-due` brings pending jobs forward. Their steps are unchanged, so the worker
    still consults before any resend.
  - `replay-outbox` writes an audited request to `fiscal_outbox_replays`. The relay
    publishes the event again under its own id, which consumers already deduplicate. The
    outbox row stays immutable, and at most one replay of an event is pending at a time.

  Each command touches at most 100 rows, writes an audit entry and prints what it
  changed. None can create a document, a number, stock or money.

## Consequences

- An operator sees everything that is waiting or uncertain in one place, and the product
  shows every simulated document with its "no fiscal value" label.
- Metrics cannot tell which tenant is late. An alert leads to the support read or the
  CLI, which is scoped by tenant. This is on purpose.
- The worker's gauges cover only the tenants it serves (`FISCAL_SERVICE_KEYS_JSON`).
- Thresholds are local defaults. The deployment owner sets production values and the
  alert channel.
- The worklist and the overview are new public reads (contracts 0.37.0, additive). The
  overview's capability list is the one place that shows NFC-e and NFS-e rows next to the
  NF-e 55 rows of `/capabilities/v2`.

## Alternatives rejected

- **Per-tenant metric labels.** Useful for debugging, but they would publish tenant ids
  to every observability backend, and cardinality grows with customers.
- **Clearing `delivered_at` to replay.** It would weaken the outbox immutability of ADR
  0048 and lose who replayed what and why.
- **A support screen that reads the database.** It breaks one-database-per-module (ADR
  0016) and bypasses RLS and the role checks of the API.
