# Phase 70 — Service levels, synthetic monitoring, release evidence and closing Phase M

Status: **in progress**. This is the execution record for
[Phase 70 of the production readiness plan](production-readiness-implementation-plan.md#70--service-levels-synthetic-monitoring-release-evidence-and-closing-phase-m).
It closes Phase M of the [ERP expansion plan](erp-expansion-plan.md).

## Result

After this phase:
- **Six service levels are measured.** Login, order to shipment, invoice issuance
  (simulation), payment settlement, report freshness and import throughput each have:
  - an SLI, as a Prometheus recording rule;
  - an SLO, stated in [the service levels](service-levels.md);
  - an alert, with its promtool test;
  - a Grafana dashboard.
- **A synthetic probe** walks the critical path every minute: sign in, read the dashboard,
  draft a purchase order and cancel it, then sign out. It exposes its own SLI, and alerts when it fails.
- **The screens of Phase M are complete,** in pt-BR and English:
  - reports and the dashboard, with reconciliation, export and schedules;
  - controls: delegations, the ledger and treasury approval policies, consistency runs and
    the retention rules;
  - the ledger and treasury approval queues.

  Imports, the job centre, notifications, MFA and sessions, and audit already exist.
- **The release evidence:**
  - a Phase M golden path, stored: an import interrupted and finished → operate →
    reconcile → export → the drills;
  - a browser workflow;
  - the threat model and the API reference of Phase M.
- **Phase M is closed** in `docs/plan.md`, `docs/erp-expansion-plan.md` and the production
  readiness plan.

## Starting point

- **Metrics:**
  - Kong counts requests and latency per service and route, but `/auth` is one route;
  - Fiscal measures authorizations and their latency;
  - every module counts inbox, outbox and dead letters;
  - imports count the rows written and rejected;
  - nothing measures report freshness, time to ship, or a running import.
- **Alert rules** exist for Fiscal and Sales only, tested by `make test-alerts`.
- **Grafana** has one overview dashboard.
- **Reporting** has no screen: its reports, reconciliations, exports and schedules are API
  only (Phases 62 and 63).
- **Phase 68 left for this phase:** the delegation screens, and the ledger and treasury
  approval queues and policies.
- **Phase 69 found a cash difference** in the golden-path tenant. It is 21 settlements
  recorded without a treasury account: the ledger posts them to the default cash account,
  and no treasury account holds them. The check is right; the evidence explains it.

## Decisions frozen by this plan

1. **The service levels** (`docs/service-levels.md`, `infra/observability/rules/slo.rules.yml`).

   | SLI | Measured from | SLO (local default) |
   |---|---|---|
   | Login availability | Kong, a route of its own for `POST /auth/login`: answers that are not `5xx` | 99.5% over 30 days |
   | Login latency | the same route: under 1 s | 95% |
   | Order to shipment | Sales, `sales_order_to_shipment_seconds`: from confirmation to the first shipment | 95% within 48 h |
   | Invoice issuance (simulation) | Fiscal, `fiscal_authority_outcomes`: authorized among decided | 99% |
   | Payment settlement | Financial's settlement events reach Treasury and Ledger (`inbox_consumed_total` against `inbox_dead_lettered_total`) | 99.9% |
   | Report freshness | Reporting, `reporting_source_freshness_seconds`: now minus the oldest watermark per source | under 15 minutes |
   | Import throughput | the modules' import workers: rows per second while a job is active | above 0 for every active job; alert after 15 minutes stalled |
   | The probe | `horizon_probe_runs_total` | 99% of runs succeed |

   - **Alerts** use multi-window burn rates for the availability SLOs (1 h and 5 m windows
     at 14.4×), and thresholds held for a time for the others.
   - **Every alert** carries a runbook anchor in `docs/service-levels.md` and has a
     promtool test.
2. **New metrics:**
   - Sales records `sales_order_to_shipment_seconds` when a shipment leaves;
   - Reporting exposes `reporting_source_freshness_seconds{source}`, read as the relay
     role, which gains `SELECT (through)` on watermarks;
   - the four import workers expose `import_jobs_active`.
3. **The probe** (`tooling/probe`, the `horizon-probe` container).
   - **Every `PROBE_INTERVAL_SECONDS` (60):**
     1. it signs in as the probe user;
     2. it reads `GET /reporting/dashboard`;
     3. it drafts a purchase order and cancels it. Sales has no cancellable draft: placing an
        order reserves stock, and a quotation is declined only once sent;
     4. it signs out, so its sessions do not pile up.
   - **Its metrics are scraped on `:9464`:**
     - `horizon_probe_runs_total{outcome}`;
     - `horizon_probe_step_seconds{step}`;
     - `horizon_probe_last_success_timestamp_seconds`.
   - **Its user** is a dedicated account: `probe@horizon.local`, in the demo workspace, with
     Procurement `buyer` and Reporting `viewer`. It is created by `make probe-user`.
4. **The screens:**
   - **`/app/reports`:**
     - the dashboard headline at a cutoff;
     - each report's figures, with its sources, settled or not;
     - reconcile, with the run history;
     - export as CSV or XLSX, and schedule it.
   - **`/app/settings/controls`:**
     - the delegations of every module where the person holds a role that approves:
       grant, list and revoke;
     - the ledger and treasury approval thresholds, for their admins;
     - the consistency runs, and run one now;
     - the retention rules, read-only.
   - **The ledger and treasury screens** gain their queues: pending manual entries and
     pending transfers, to approve or reject.
5. **Release evidence** (`scripts/phase-m-golden-path.mjs`, stored in `docs/drills/`):
   1. **Import:** 1,000 parties with 25 invalid rows, interrupted by restarting Parties
      mid-run. It finishes with `total = written + failed + remaining + cancelled`, and 25
      failed.
   2. **Operate:** a sale through shipment, and its receivable settled into a treasury
      account.
   3. **Reconcile:** every report at a settled cutoff; `cash-position` must match with no
      difference.
   4. **Export:** the cash position as XLSX, `ready`, with its digest.
   5. **The drills:** the records of Phases 67, 68 and 69 must be present and passed.

## Work

### A — Service levels
1. The login route in the gateway.
2. The new metrics: Sales, Reporting (with its migration), and the four import workers.
3. `slo.rules.yml` with its test, the dashboard, `docs/service-levels.md`, and
   `make test-alerts`.

### B — The probe
`tooling/probe`, its tests, the Compose service, the Prometheus scrape, and `make
probe-user`.

### C — Web
The reports screen, the controls screen, the approval queues, their messages, and tests of
their pure parts.

### D — Evidence and closing
1. The Phase M golden path.
2. A browser run.
3. `docs/phase-m-threat-model.md` and `docs/controls-api.md`.
4. Close Phase M.

## Exit evidence

The three exit criteria of the expansion plan, each proven by a stored artifact:
1. reconciliation runs at a settled cutoff with zero difference;
2. an interrupted import with failed rows is finished and fully accounted for;
3. the security and restore drill records exist.
