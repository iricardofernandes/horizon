# Phase 63 — evidence: exports and scheduled exports

Status: **delivered on 2026-09-27** (local runs between 20:30 and 21:00 UTC).
Plan: [readiness-phase63-implementation-plan.md](readiness-phase63-implementation-plan.md).
Decision: [ADR 0059](adr/0059-bulk-data-jobs-belong-to-the-owning-module.md).
API: [reporting-api.md](reporting-api.md#exports-phase-63).

## What was delivered

- **Export jobs in `reporting/`:**
  - `POST /exports`, then a worker writes the file;
  - `GET /exports/{id}/link` gives a link signed for 15 minutes;
  - the public, signed `/exports/{id}/file` serves it with its digest.
  - Jobs record rows, bytes, SHA-256, whether the cutoff was settled, and when the file
    expires.
- **Files:**
  - the metadata rows, then the report's table;
  - CSV per locale (`;` and a decimal comma in pt-BR);
  - XLSX written with `fflate` and nothing else;
  - neutralized formulas in both.
- **Storage:** an object store port, with S3 (MinIO) in the stack and a directory in tests.
  MinIO left the `fiscal` profile, and `minio-init` creates `horizon-exports`, versioned.
- **Scheduled exports:**
  - daily, weekly or monthly at local midnight in an IANA timezone;
  - each run's cutoff is its due instant;
  - a run waits for settlement up to a grace, then runs marked unsettled;
  - missed runs are made once each, in order.
- **Retention:** files are removed after `EXPORT_RETENTION_HOURS`, and the job stays as
  `expired`.
- **The worker:**
  - it finds tenants with work as the relay role, which reads only scan columns;
  - it claims with `FOR UPDATE SKIP LOCKED`;
  - a job whose worker died is taken again after a lease.
- **List exports in the web:**
  - `GET /api/export/<module>/<path>` pages a list in any of the modules' three paging
    styles, as the signed-in user, up to 50,000 rows;
  - the export button sits on the CRM accounts and pipeline, Catalog items and
    Procurement orders, in pt-BR and English.

## Exit criteria

| Criterion | Evidence |
|---|---|
| `make check` and the local CI pass | see Verification |
| An exported report's totals equal the report at the same cutoff | smoke, twice: each of the four reports exported as CSV (pt-BR) and XLSX (en) at a settled cutoff; every figure checked against the report's JSON (3 account balances; confirmed, shipped and raised totals; committed and received; won by month) is equal in the CSV and present in the XLSX |
| A user without read access to a module cannot export its list | smoke: a user with no CRM role gets `403` from the web list export, and no file; the relay role is refused the content of export rows (e2e) |
| Formula injection is neutralized | smoke: a prospect named `=HYPERLINK("http://x") …` exports as `'=HYPERLINK(…`; unit tests in CSV and XLSX for `=`, `+`, `-`, `@`, tab and carriage return |
| A missed scheduled run is made once, with its own cutoff | smoke: a daily schedule made three days late produced exactly three runs, cut at 2026-09-25, 26 and 27 00:00 UTC; e2e: two workers on the same schedule make one run per instant, and a later pass catches up three more days |

## Smoke (`node scripts/phase63-smoke.mjs`)

Run on the golden-path tenant, whose history holds real money:

| Step | Result |
|---|---|
| Seal-only in five producers | every watermark reaches the cutoff |
| cash position | CSV 3 rows (339 bytes), XLSX 1933 bytes |
| order to cash | CSV 1 row (348 bytes), XLSX 1920 bytes |
| procure to pay | CSV 1 row (300 bytes), XLSX 1889 bytes |
| pipeline to revenue | CSV 1 row (306 bytes), XLSX 1890 bytes |
| Each file | figures equal to the report's JSON; `settled` true; the `Digest` header equals the job's SHA-256 |
| Signed link | valid `200`; changed signature, stretched expiry, other tenant: `403` each |
| Daily schedule, three days late | three runs, one per missed midnight, all `ready`; schedule removed |
| List export through the web | `crm/accounts?role=prospect` as an analyst: `200` CSV with `filter;role=prospect`, the formula-looking name quoted; as a user without a CRM role: `403` |

The smoke passed twice in a row, and once more after the last fix.

## Tests

- **`reporting/` units, 63 tests; coverage 98.9% of lines in `domain/` and
  `application/`:**
  - cells, currencies (BRL, JPY, KWD), due instants (São Paulo, UTC, Berlin, New York
    across daylight saving), file names;
  - report tables;
  - request, write, fail, lease, retention, visibility;
  - schedules: catch-up, settle grace, pause, remove, permissions;
  - CSV and XLSX read back;
  - signed links: tampered, expired, other tenant, over-long.
- **`reporting/` e2e, 15 tests:**
  - two workers writing two exports exactly once, both formats read back from disk;
  - a missed schedule caught up by two workers at once, then three more days;
  - retention;
  - cross-tenant reads;
  - the relay role refused the export content.
- **Web:** 4 new unit tests of the list exporter (paging styles, flattening, CSV,
  neutralization). The copy check passes: the button's labels are in the message
  catalogues.

## Findings along the way

- **Exports need object storage in the default platform.** MinIO had been started only
  with the fiscal profile. It is now always started, and reporting waits for its bucket.
- **Removing a schedule must not remove what it made,** so `export_jobs.schedule_id` has
  no foreign key. The unique index on `(schedule_id, cutoff)` still keeps each run to one.

## Verification

- `make check`: passed.
- Local CI (`make ci-local`): passed at every step ("Local code and integration gates
  passed"): repository, pins, contract compatibility, generated files, build and tests of
  every project, and e2e of every service.
- The smoke ran a third time after the XML writer learned to drop control characters, and
  passed.
