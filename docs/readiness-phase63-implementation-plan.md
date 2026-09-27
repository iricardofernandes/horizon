# Phase 63 — Exports and scheduled exports

Status: **delivered on 2026-09-27** ([evidence](readiness-phase63-evidence.md)). This is the execution record for
[Phase 63 of the production readiness plan](production-readiness-implementation-plan.md#63--exports-and-scheduled-exports).
Decision: [ADR 0059](adr/0059-bulk-data-jobs-belong-to-the-owning-module.md).

## Result

After this phase:
- **Export jobs.** A person asks `reporting/` for any of the four reports at a cutoff,
  with a filter, as CSV or XLSX.
  - A job writes the file to object storage, and the file downloads through a link signed
    for 15 minutes.
  - The file expires after its retention, and the job says so.
- **Scheduled exports.** A schedule exports a report daily, weekly or monthly, at
  midnight in its own timezone.
  - The cutoff of each run is the instant it was due.
  - A run missed while the service was down is still made, once, never skipped.
- **List exports.** Any list screen whose API pages can be exported to CSV by the web
  server:
  - with the signed-in user's own token;
  - up to 50,000 rows;
  - with a header that states the instant, the list and its filter.
- **Neutralized formulas.** No exported cell can become a spreadsheet formula.

## Starting point

- **Reports.** They are queries over the journal at a cutoff, with filters and saved
  filters (Phase 62).
- **Object storage.** MinIO runs only in the `fiscal` profile of the local stack.
  - Fiscal writes to it with `@aws-sdk/client-s3`.
  - Fiscal also has a filesystem store for tests.
- **XLSX.** `fflate` (zip) is already used by Fiscal. No project writes XLSX today.
- **Gateway.** Kong does not demand a token on `/reporting`: each service checks its own,
  so a public route can check a signature instead.
- **List APIs page in three ways:**
  - `{ data, page: { limit, offset, total } }` (CRM, Inventory);
  - `{ data, total }` (Procurement);
  - `{ data, page: { hasMore, nextCursor } }` (Catalog).

  Some lists are a bare array.
- **The web proxy** calls the modules with the session's access token, from the server
  (`authenticatedFetch`).
- **No reports screen exists** until Phase 70.

## Decisions frozen by this plan

1. **An export is a job.**
   - A job holds the requester, the report, the filter, the cutoff, the format and the
     locale.
   - **States:** `requested → running → ready | failed`, and later `expired`.
   - It records the file's size and SHA-256 and its row count. It also records whether the
     cutoff was settled when the file was written, so a provisional export says so.
   - A worker in `reporting/` claims jobs with `FOR UPDATE SKIP LOCKED`. It finds the
     tenants that have work through the relay role, which reads only the scan columns.
     This is the CRM reminder pattern of Phase 57.
2. **Object storage behind a port.**
   - **Where the file goes:**
     - S3 (MinIO) in the stack;
     - the filesystem in tests.
   - **Key:** `exports/<tenant>/<job>.<ext>`, generated, never taken from a request.
   - **MinIO joins the default platform:** it leaves the `fiscal` profile, and
     `minio-init` also creates `horizon-exports`, versioned.
3. **Signed download links.**
   - `GET /exports/{id}/link` gives a URL valid for 15 minutes, only to the requester or to
     an administrator. The URL is
     `/reporting/exports/{id}/file?tenant=…&expires=…&signature=…`.
   - The signature is an HMAC-SHA256 with `EXPORT_LINK_SECRET` over the tenant, the job and
     the expiry.
   - The file route is public. It checks the signature, the expiry and the job's state, and
     serves the bytes with the file name and the digest.
   - Object storage is never exposed to the browser.
4. **The file.**
   - **Metadata rows first:** report, cutoff, settled, filter, generated at, locale. Then a
     blank row, then the table.
   - **Amounts:** converted from minor units by the currency's own digits (`Intl`).
   - **CSV:**
     - UTF-8 with a BOM;
     - `;` and a decimal comma in pt-BR, `,` and a decimal point in English;
     - RFC 4180 quoting.
   - **XLSX:**
     - one sheet, numbers as numbers, strings inline;
     - written with `fflate` and no other dependency.
   - **Formula injection:** any text cell starting with `=`, `+`, `-`, `@`, a tab or a
     carriage return is prefixed with `'`. Numbers are numbers, never text.
   - **Rows per report:**

     | Report | One row per |
     |---|---|
     | cash position | section (receivables, payables, account) and key |
     | order to cash | currency |
     | procure to pay | currency |
     | pipeline to revenue | month and currency, then the accepted quotes per currency |
5. **Scheduled exports.**
   - **What a schedule holds:**
     - its owner, report, filter (typed or copied from a saved filter), format and locale;
     - a cadence (`daily`, `weekly` on Mondays, `monthly` on the 1st) and an IANA
       timezone;
     - the next instant it is due.
   - When a schedule is due, its run is a job whose cutoff is that due instant. A run is
     unique per schedule and cutoff.
   - **Settlement:**
     - the run waits until its cutoff is settled for the report's sources;
     - after `EXPORT_SETTLE_GRACE_MS` (default one hour) it runs anyway, marked unsettled;
     - either way, the schedule then moves to its next due instant.
   - **Catching up:**
     - every overdue instant is exported in order, one run each;
     - a schedule down for a week makes seven daily runs, not one.
   - Pausing a schedule stops new runs, and resuming it catches up from where it stopped.
     Deleting it keeps the runs already made.
6. **Retention.**
   - A ready file expires `EXPORT_RETENTION_HOURS` (default 72) after it was written.
   - The worker deletes the object and marks the job `expired`, and logs the count per
     tenant.
   - The job row stays, as history.
7. **List exports from the web server.**
   - The route is `GET /api/export/<module>/<list path>?<the list's own query>&locale=…`.
   - It follows any of the three paging styles, 200 rows a page, up to 50,000 rows, and
     stops with a truncation row if there are more.
   - It flattens each row: nested objects as dotted columns, arrays as JSON.
   - It streams CSV with the metadata rows: list, instant, filter.
   - Every call is the user's own, so a user without read access gets the owner's `403`,
     and no file.
   - The allowlist of modules is the proxy's own.
   - The list export is CSV only. A spreadsheet of a report comes from a report export.
8. **Roles in reporting:**

   | Action | Roles |
   |---|---|
   | `export` | `admin`, `analyst`, `viewer` |
   | `schedule` | `admin`, `analyst` |

   Anyone who may read a report may export it. A schedule runs as its owner would read the
   report, and nothing it produces is shown to anyone else, except to an administrator.

## Work

### A — Reporting

1. **The domain:**
   - the report table (columns and rows per report);
   - cell values and formula neutralization;
   - due instants per cadence and timezone;
   - link signatures;
   - job and schedule states.
2. **The application:**
   - `RequestExport`, `ProcessExports`, `ScheduleExport` and `RunDueSchedules`;
   - `ExpireExports`;
   - `ExportLink`.
3. **The infrastructure:**
   - the CSV and XLSX writers;
   - `S3ObjectStore` and `FileObjectStore`;
   - migration `0002_exports.sql`: `export_jobs` and `export_schedules`, with forced RLS
     and relay scan grants;
   - the export worker (jobs, due schedules, retention);
   - the controllers: `/exports`, `/exports/{id}`, `/exports/{id}/link`,
     `/exports/{id}/file`, `/export-schedules`.
4. **Tests:**
   - unit tests of everything in the domain and application;
   - e2e: a job from request to file; the XLSX read back; a link that expired and one
     tampered; catching up a schedule; the retention; two workers never exporting twice;
     cross-tenant reads.

### B — Web

1. `src/app/api/export/[...path]/route.ts` and a pure `lib/list-export.ts` (paging, flattening,
   CSV, neutralization), with unit tests.
2. An `ExportButton` for list screens, placed on:
   - the CRM accounts and the pipeline table;
   - Catalog items;
   - Procurement orders.

   Its labels are in pt-BR and English.

### C — Platform and evidence

1. **Compose:**
   - MinIO out of the `fiscal` profile, and the `horizon-exports` bucket;
   - the reporting store and link settings.
2. `scripts/phase63-smoke.mjs`:
   - export each report as CSV and as XLSX;
   - the totals equal the report's JSON at the same cutoff;
   - the link works once signed, and fails tampered or expired;
   - a schedule created with an overdue instant runs, and catches up;
   - a list export through the web as a user with the role, and `403` without it;
   - a formula cell comes out neutralized.
3. `docs/reporting-api.md` and the glossary.

## Exit evidence

- `make check` and the local CI pass.
- An exported report's totals equal the report at the same cutoff.
- A user without read access to a module cannot export its list.
- Formula injection is neutralized, in CSV and in XLSX.
- A missed scheduled run is made once, with its own cutoff.

## Revisions made while implementing

- **A file's rows are its report's rows.** The XLSX is built from the same table as the
  CSV, so the two can never disagree about what was exported.
- **Catching up happens on one worker pass, in order.** Each due instant is checked for
  settlement by itself, and a pass stops at the first one still waiting.
- **The relay role reads four columns of `export_jobs` and three of `export_schedules`.**
  A test proves it is refused the report, the filter and the requester.
- **The list export route reads one page at a time into memory** (at most 50,000 flattened
  rows) before writing the file, rather than streaming. That keeps the refusal of the
  first page a clean `403` instead of a broken download.

## Out of scope

- **A reports screen with an export button** (Phase 70). Reports are exported through the
  API until then.
- **Notifications** when an export is ready (Phase 66), and the job centre.
- **XLSX of a list.** List exports are CSV.
- **E-mailing an export.**
