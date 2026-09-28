# Phase 64 — evidence: bulk imports with preview and failures you can download

Status: **delivered on 2026-09-28** (local runs between 12:00 and 13:30 UTC).
Plan: [readiness-phase64-implementation-plan.md](readiness-phase64-implementation-plan.md).
Decision: [ADR 0059](adr/0059-bulk-data-jobs-belong-to-the-owning-module.md).
API: [imports-api.md](imports-api.md).

## What was delivered

- **The contract.**
  - `@horizon/contracts` 0.47.0 publishes the import job:
    - the states;
    - the progress, with its invariant;
    - the job, kind, field, upload, mapping, preview and row-error shapes;
    - the limits.
  - Every consumer is pinned to 0.47.0.
- **One engine per module, copied, not shared.**
  - The domain (states, progress, locale numbers and dates, the mapping suggestion) and
    the application (upload, map, preview, confirm, cancel, failures, the worker pass).
  - The infrastructure:
    - a CSV and XLSX reader and failures writer, on `fflate` alone;
    - the SQL store;
    - the relay scan and worker;
    - the controller.
  - It lives in Parties, Catalog, Inventory and Financial, identical but for the imports
    of each module.
- **Seven importers,** each through the module's own use cases:

  | Module | Kinds |
  |---|---|
  | Parties | `parties` |
  | Catalog | `units`, `items`, `prices` |
  | Inventory | `opening-stock` |
  | Financial | `receivables`, `payables` |
- **Exactly once.**
  - Parties, Catalog and Inventory mark the row written in the transaction that writes
    it, through a decorated unit of work.
  - Financial keys its draft and post by the row, and marks the row inside the post (or
    the approval request).
- **Personal data.** Parties seals the rows under a key per job. The key is destroyed when
  the rows are cleared.
- **The web.** `/app/administration/imports` offers the modules the user administers. It
  runs upload, mapping, preview, confirm, polled progress, cancel and the failures
  download, and lists the module's recent jobs. It is in pt-BR and English.

## Exit criteria

| Criterion | Evidence |
|---|---|
| `make check` and the local CI pass | see Verification |
| Killing the service mid-import and restarting it finishes with every row written once | smoke: `docker kill horizon-parties` with 72 of 1,500 parties written; after `docker start` the job resumed when its lease lapsed and ended with exactly 1,500 parties in the database and `written: 1500`. e2e in all four modules: a worker dies after N writes, a second one finishes, and each record exists once |
| A file with invalid rows imports the valid ones, and reports every invalid one with its line and reason | smoke: the three bad Parties rows (a short CNPJ, a repeated CNPJ, an unknown kind) come back in `arquivo-falhas.csv` as lines 1502–1504 with their reasons; Catalog, Inventory and Financial each import their valid rows and refuse the rest (an unknown unit, SKU, warehouse or party). e2e: the failures file read back in CSV and XLSX |
| The totals on the screen always add up to the file's row count | the contract's schema refuses progress that does not add up; every smoke step asserts it on every job it reads; the web shows a warning if it ever did not |
| Importing the same file twice with the same job key writes nothing new | smoke: the same file under the same key is `200` with the same job, and the party count is unchanged; the same key with another file is `409`. e2e in Parties |

## Smoke (`node scripts/phase64-smoke.mjs`)

It runs in a fresh workspace each time.

| Step | Result |
|---|---|
| Parties: 1,503 rows, killed mid-import | `total 1503, valid 1500, written 1500, failed 3`; 72 written when killed |
| Same key and file / other file | `200` same job / `409`; still 1,500 parties |
| Failures file | header plus `linha;motivo`, three rows with their reasons |
| Import rows sealed | no row holds a party name in clear |
| No role, no import | `403` on upload and list in all four modules for editor/operator roles |
| Catalog through the web proxy | units 2 written and 2 failed; items from XLSX 3 and 1, with the NCM `09012100` restored; prices 2 and 1, with the list created |
| Inventory | opening stock 2 and 1; 52.5 units on hand |
| Financial through the web proxy | 5 receivables of imported customers posted, 1 refused (unknown party); 5,000.10 outstanding |
| Web | `/app/administration/imports` answers `200` |

The wizard was also driven in Chromium as the demo operator:
1. a units CSV with an invalid code;
2. the preview showed line 4 and its reason, and the two valid rows;
3. "Import 2 valid rows";
4. the job ended `completed with failures` (2 written, 1 failed), with the failures
   download offered.

## Tests

- **Contracts:** 7 new tests (the progress invariant, states, upload and mapping shapes).
- **Units in the modules** (engine and importers, including authorization):
  - Parties 44, Catalog 41, Inventory 39, Financial 38.
  - The engine's tests cover upload idempotency, mapping and duplicates, preview gating,
    batches, crash and resume by lease, a row taken by another writer, cancellation,
    retention and abandonment, and tenancy.
- **e2e against PostgreSQL:**
  - Parties 9: sealed rows; the same result as the API; key destruction; a worker killed
    mid-job; a taken row rolled back; the same key twice; cancel; RLS; the relay role.
  - Catalog 3, Inventory 3, Financial 4: import with failures; crash and resume; the
    relay role refused the rows. Financial also has a held payable left awaiting approval.
  - The existing suites of the four modules pass, and Catalog's OpenAPI list includes the
    import routes.
- **Web:** 8 new unit tests (the upload body, Windows-1252, the job key, progress, the
  navigation entry). The copy check passes.

## Findings along the way

- **Financial posts only classified titles.** The category is therefore a required field,
  given by its code.
- **A payable held by the approval policy is not posted and left pending.** Posting
  refuses it until approved. The importer drafts it and requests approval instead. The
  row is written with the request, and a second person approves.
- **Spreadsheets drop leading zeros.**
  - An NCM of seven digits, and a CPF or CNPJ missing up to three zeros, get them back.
  - A number shorter than that stays invalid: the smoke caught `123` being padded into a
    well-formed CNPJ.
  - The XLSX writer keeps a value with a leading zero as text.
- **`toSnapshot()` is infrastructure-only (ADR 0031).** The importers use small accessors
  instead: `UnitOfMeasure.code()`, `PriceList.name()` and `currency()`, and
  `Warehouse.name()`.
- **The contract compatibility gate compared nullable types by reference.** A type such
  as `["string", "null"]` never equalled itself, so the first nullable field inside an
  array was reported as a breaking change. `scripts/lib/contract-diff.mjs` now compares
  type members, with a test.
- **Catalog's idempotency interceptor would have cached an 8 MB upload.** The upload route
  skips it: the job key is the job's own idempotency.

## Verification

- `make check`: passed.
- Local CI (`make ci-local`): every step passed except contract compatibility, which
  failed on the false positive above. After the fix the affected steps were run again
  and passed: contract compatibility ("no schema changes"), the repository script tests
  (22), documentation links, boundaries and the whitespace check. The steps that passed
  include the build, unit and e2e tests of every project, and the generated files.
- The smoke passed after the last fix of the document padding.
