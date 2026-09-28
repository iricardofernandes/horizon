# Phase 70 — evidence: service levels, the probe, the Phase M screens and closing Phase M

Status: **delivered on 2026-09-28** (local runs between 20:10 and 21:00 UTC). **Phase M is
closed.**
Plan: [readiness-phase70-implementation-plan.md](readiness-phase70-implementation-plan.md).
Service levels and runbooks: [service-levels.md](service-levels.md).
Golden path record: [drills/2026-09-28-phase-m-golden-path.json](drills/2026-09-28-phase-m-golden-path.json).
Threat model: [phase-m-threat-model.md](phase-m-threat-model.md). API: [controls-api.md](controls-api.md).

## What was delivered

- **Service levels.** Eight SLIs are recorded once each in
  `infra/observability/rules/slo.rules.yml`. Each alert has a runbook anchor, and
  `slo.rules.test.yml` tests every alert and two of the SLIs. The CI `platform` workflow
  runs `make test-alerts` in a new `alerts` job. The Grafana dashboard *Horizon — service
  levels* (`horizon-service-levels`) has 16 panels.

  New signals behind the SLIs:
  - **Kong:** a route of its own for `POST /auth/login` (`identity-login`), with the same
    rate limit (30 a minute per IP).
  - **Sales:** `sales_order_to_shipment_seconds`, recorded when a shipment leaves.
  - **Reporting:** `reporting_source_freshness_seconds{source}`, read as the relay role.
    The relay gains `SELECT (source_module, through)` on `source_watermarks` (migration
    `0006_freshness`), and still cannot read `seal_id` (e2e).
  - **Import workers:** Parties, Catalog, Inventory and Financial expose
    `import_jobs_active`.
- **The synthetic probe** (`tooling/probe`, the `horizon-probe` container, scraped on
  `:9464`).
  - Every minute, through Kong, it signs in, reads the dashboard, drafts a purchase order
    shaped on the newest one, cancels it, and signs out.
  - It runs as `probe@horizon.local`, with Procurement `buyer` and Reporting `viewer`,
    created by `make probe-user`.
  - Pure steps and metrics, with 8 tests.
- **Treasury** gains `GET /treasury/approval-policies`, so the screens can show its
  thresholds (e2e).
- **Screens** (pt-BR and en, with tested pure parts):
  - **`/app/reports`:**
    - the dashboard at the latest cutoff;
    - one report at a chosen cutoff and currency, with where each source stands and its
      figures, amounts formatted;
    - reconcile now, with the run history;
    - export as CSV or XLSX, schedules, and a download through a signed link.
  - **`/app/settings/controls`:**
    - delegations in each module the person has a role in, to lend and revoke;
    - Ledger and Treasury thresholds, set by their admins, amounts typed in either
      convention;
    - consistency runs, run now;
    - retention, read-only.
  - **The Ledger and Treasury screens** show what waits for a second person, to approve or
    to reject with a reason.
- **Release evidence:** `scripts/phase-m-golden-path.mjs` (`make phase-m-golden-path`), the
  threat model and the controls API reference.
- **Plans:** Phase M is closed in [plan.md](plan.md),
  [erp-expansion-plan.md](erp-expansion-plan.md) and the
  [production readiness plan](production-readiness-implementation-plan.md).

## Exit criteria

| Criterion | Evidence |
|---|---|
| **A reconciliation at a settled cutoff with zero difference** | Golden path. Financial and Treasury sealed (15 and 3 events). `cash-position` at `2026-09-28T20:35:52.971Z` is `settled` and shows the golden path's account at 2,500. The run `01a0e9bd-0214-…` is `matched` in all three checks: receivables, payables and account balances |
| **An interrupted import with failed rows, finished and fully accounted for** | Golden path. 1,025 rows (25 invalid). `docker restart horizon-parties` with 88 written and 912 remaining. It ended `completed-with-failures`: 1,000 written, 25 failed, 0 remaining, and exactly 1,000 parties in the database |
| **The security and restore drill records** | The golden path read the Phase 67, 68 and 69 records: all `"passed": true`, with 4, 4 and 7 checks |

### The Phase M golden path

`node scripts/phase-m-golden-path.mjs` ran through Kong from 20:35:23 to 20:37:57 UTC and
stored `"passed": true`.

| Step | Result |
|---|---|
| Load | as above |
| Operate | quote → order → shipment dispatched → receivable classified, posted and settled (12.50) into the treasury account *Caixa Fase M*. The account's book balance rose by exactly the amount received, and the title is `settled` |
| Report | as above |
| Export | XLSX of `cash-position` at the same cutoff: `ready`, `settled`, 2 rows, 1,866 bytes. The downloaded bytes hash to the listed SHA-256 (`5550…91f8`) |
| Drills | as above |

## Service levels on the live stack

After rebuilding Sales, Reporting, the four import services, Treasury, web and the probe,
and restarting Kong and Prometheus:
- `horizon_probe_runs_total`: 25 successes and 1 failure. The failure was the first run,
  during Kong's restart, logged as `step: dashboard, status: 502`. After it,
  `sli:probe_success:ratio_rate1h` = 1. A run takes about 0.1 s: sign-in 0.05, dashboard
  0.02 to 0.05, draft 0.01 to 0.03.
- Every probe draft ended `cancelled` (Procurement database).
- `sli:login_errors:ratio_rate1h` = 0, `sli:login_under_1s:ratio_rate5m` = 1,
  `sli:settlement_delivered:ratio_rate1h` = 1, and
  `sli:order_to_shipment_within_48h:ratio_rate1d` = 1 (3 shipments).
- `import_jobs_active` is exported by all four import services.
- `reporting_source_freshness_seconds` is exported for every source with a watermark.
- `ReportsStale` fires for CRM and Ledger (see the findings).

## Browser run (Chromium, as the demo operator)

- **Reports:**
  - the dashboard showed the four reports at the latest cutoff, each `pending`;
  - `cash-position` showed Financial and Treasury with their watermarks, the three account
    balances, and five `matched` reconciliation runs;
  - *Export now* produced an XLSX that listed as `ready`;
  - *Download* saved `cash-position-20260928-2039Z.xlsx`, whose SHA-256 (`5d83…7956`)
    equals the digest on the row.
- **Controls:**
  - delegations, thresholds, the consistency runs and retention rendered;
  - differences show as money (module R$3,223.50, ledger R$3,486.00);
  - the Treasury threshold was set to `1.000,00` through the form, and Treasury stored
    `100000`.
- **The Treasury queue:**
  - A transfer of R$1,500.00 asked by another person showed under *Transfers waiting for
    approval*.
  - *Approve* posted it, with `decided_by` the demo operator.
  - A transfer the demo operator had asked for themselves was refused on the row with
    Treasury's own message: "the person who asked for a transfer cannot decide it" (`403`).
    It was then rejected by a second person.
- **The Ledger screen** loads with its (empty) queue.
- **At 390 px wide,** reports and controls have no horizontal overflow outside their
  scrolling tables.

## Tests

- `tooling/probe`: 8 tests (every step and its failures, sign-out after a failure, the
  metrics).
- **Web:**
  - `src/lib/controls.spec.ts` and `src/lib/reports.spec.ts`: who is asked, periods,
    thresholds in both conventions, report figures as tables, amount columns, links,
    abilities;
  - the approval queue order in `features/treasury/types.spec.ts`;
  - the new navigation entries.
- `make test-alerts`: the SLO rules, including a sign-in with no `5xx` recorded as 0.
- **e2e:** Treasury (the policy read), Reporting (the freshness gauge as the relay role),
  Financial and Catalog imports (`runningJobs`).
- **Sales:** the shipping lead time is recorded (`shipping.spec.ts`).

## Findings along the way

- **The cash difference in the consistency runs is explained, not a defect.**
  - Cash accounts differ by R$262.50 in the demo workspace: the Ledger has R$3,486.00, the
    Treasury accounts R$3,223.50.
  - The cause is 21 settlements recorded without a treasury account. They add up to exactly
    26,250. The Ledger posts them to the default cash account, and Treasury has no account
    to hold them.
  - It is data from before settlements named an account, and it stays visible, as it
    should.
- **A foreign event holds CRM's watermark in the demo workspace.**
  - Reporting's journal holds a `crm.task.due` (trace `ccc…`, 15:13 UTC) that CRM never
    wrote. It looks like a test event injected by hand.
  - Every CRM seal since is `mismatched` (producer 2, journal 3). The watermark stays at
    15:06, and `ReportsStale{source="crm"}` fires, as designed.
  - The row was left in place.
- **Seals skip a tenant with no events from a source.** The periodic seal walks the outbox,
  so the golden path workspace's Ledger and Treasury watermarks were a day old until the
  golden path republished Treasury. This is listed as open in the threat model.
- **Two SLI rules were wrong, and their tests shared the mistake.**
  - OpenTelemetry writes bucket bounds as floats (`le="172800.0"`), so the order-to-shipment
    SLI matched nothing.
  - With no `5xx`, the sign-in error ratio was a missing series rather than 0.
  - Both were found on the live Prometheus, then fixed in the rules and the tests.
- **A seal covers only what is two minutes old** (`SEAL_MARGIN_MS`). The golden path's first
  run sealed before its own settlement and saw the report without it. It now asks for
  seals until they reach past the settlement.
- **The demo operator had no Reporting role.** The workspace was seeded before Reporting
  existed. `demo.mjs` grants it on its next run, and it was granted by hand for this run.
- **Thresholds are typed as people write them:** `1.000,00` was refused at first, and the
  parser now takes both conventions.

## Verification

- `make check`: `all projects ok`, exit 0. It covers lint, boundaries, the contract pins,
  the UI copy check, typecheck and unit tests of every project, `tooling/probe` included.
- `make test-alerts`: every rule file `SUCCESS`, after the two SLI fixes.
- `make test-phase10`: the golden path in Chromium passes, with one trace across financial,
  gateway, inventory, reporting, sales, web and webhooks, and a responsive check at 390 px.
- `node scripts/check-doc-links.mjs`: every relative link resolves.
- `node scripts/phase-m-golden-path.mjs`: `"passed": true` (above).
