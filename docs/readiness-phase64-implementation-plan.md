# Phase 64 — Bulk imports with preview and failures you can download

Status: **delivered on 2026-09-28** ([evidence](readiness-phase64-evidence.md)). This is the execution record for
[Phase 64 of the production readiness plan](production-readiness-implementation-plan.md#64--bulk-imports-with-preview-and-failures-you-can-download).
Decision: [ADR 0059](adr/0059-bulk-data-jobs-belong-to-the-owning-module.md).

## Result

After this phase:
- **One job contract, four importers.** Parties, Catalog, Inventory and Financial each
  import a CSV or XLSX file through the same contract:
  - the same states, endpoints and progress shape;
  - the same failures file.

  The contract is published once in `@horizon/contracts` 0.47.0.
- **What each module imports:**

  | Module | Kind | One row is |
  |---|---|---|
  | Parties | `parties` | a party with its kind, document, contact details and roles |
  | Catalog | `units` | a unit of measure |
  | Catalog | `items` | an item, with its unit by code |
  | Catalog | `prices` | a price of an item (by SKU) in a price list (by name) |
  | Inventory | `opening-stock` | a quantity of an item in a warehouse, with its cost, and optionally a lot or serials |
  | Financial | `receivables` | an open receivable at go-live, one installment |
  | Financial | `payables` | an open payable at go-live, one installment |
- **The flow:**
  1. upload a file;
  2. map its columns to the importer's fields;
  3. every row is validated by the module's own value objects;
  4. a preview shows the counts and the first errors;
  5. the person confirms;
  6. a worker writes the valid rows in batches, through the module's own use cases.

  A restart resumes where it stopped, and no row is ever written twice.
- **Failures.** Every refused row stays in the job with its line and reasons. They
  download as a file in the input's own format, with the reason in an extra column.
- **The web import wizard** drives any of the four, from one screen.

## Starting point

- **The one import today** is Treasury's bank statement (Phase 20). The file travels as
  JSON text, and the body limit is raised for it.
- **How each module writes:**
  - Parties, Catalog and Inventory write each command in one `inTenant` transaction;
  - Financial and Inventory also have `once`, an idempotent command keyed by the caller
    (ADR 0028). Financial drafts and posts a title with two such commands.
- **References to other modules:**
  - Inventory knows items by id only. Its catalogue projection holds compositions, not
    SKUs.
  - Financial knows parties by id and legal name only. Documents are Parties' personal
    data (ADR 0026).
- **Personal data.** Parties encrypts every personal field under a key per party, and
  erasing destroys the key. Parties is the only one of the four whose import rows hold
  personal data.
- **The relay role.** Every service has `DATABASE_RELAY_URL`. Phase 63's worker uses it to
  find tenants with work through scan-column grants.
- **XLSX.** Reporting writes it with `fflate` (Phase 63). Nothing reads it yet.
- **The web proxy** forwards `content-type` and `idempotency-key` with any body.

## Decisions frozen by this plan

1. **The contract (`@horizon/contracts` 0.47.0, `http/imports.ts`).**
   - **States:**
     - `uploaded`: the file is parsed into rows and waits for a mapping;
     - `validated`: every row was checked against a mapping;
     - `previewed`: the preview was shown, and only now may it be confirmed;
     - `running`;
     - then one of `completed`, `completed-with-failures` or `cancelled`.
     A new mapping sends a `validated` or `previewed` job back to `validated`.
   - **Progress:** `{ total, valid, written, failed, remaining, cancelled }`.
     - `total = written + failed + remaining + cancelled`, always.
     - `failed` counts the rows refused by validation and those refused when written.
     - `valid` is `total` minus the rows refused by validation, once validated.
     - A job is `completed` only when `remaining` and `cancelled` are 0 and `failed` is
       0. With failures it is `completed-with-failures`. So "completed" is never shown
       while a row is unaccounted for.
   - **The shapes:** job, field, upload, mapping, preview and row error. The limits are
     10,000 rows and 5 MB per file.
   - **Endpoints,** under each module's prefix:

     | Route | Does |
     |---|---|
     | `GET /imports/kinds` | the kinds and their fields |
     | `POST /imports/{kind}` | uploads a file; the `Idempotency-Key` header is the job key |
     | `GET /imports` | recent jobs |
     | `GET /imports/{id}` | one job with its progress |
     | `PUT /imports/{id}/mapping` | maps the columns and validates every row |
     | `POST /imports/{id}/preview` | the counts, the first 50 errors and the first 10 valid rows |
     | `POST /imports/{id}/confirm` | starts writing |
     | `POST /imports/{id}/cancel` | stops before the next row |
     | `GET /imports/{id}/failures` | the failures file |
2. **Upload.**
   - The body is `{ fileName, format: 'csv' | 'xlsx', locale: 'pt-BR' | 'en', content }`.
     `content` is the text of a CSV, or the base64 of an XLSX.
   - **CSV:** UTF-8, with or without a BOM. The separator is read from the header line
     (`;` or `,`), with RFC 4180 quoting. Blank lines are skipped, and a line's number is
     its line in the file.
   - **XLSX:** the first sheet, read with `fflate` and a small reader of the sheet XML
     (shared strings, inline strings, numbers, booleans).
   - **The locale** decides the decimal separator of amounts and quantities (`1.234,56`
     or `1,234.56`). Dates are `YYYY-MM-DD`, `DD/MM/YYYY`, or a spreadsheet date number.
   - **The job key.** The same key and the same file digest return the same job
     (`200`), and nothing is written again. The same key with another file is `409`.
     Without a key the upload is refused.
3. **Mapping.** The server suggests a mapping by matching normalized header names to
   field names and their pt-BR and English labels. The person may change it. A required
   field without a column refuses the mapping.
4. **Validation** happens during the mapping request, over every row:
   - with the module's value objects (the same ones its use cases call);
   - with lookups the module can answer: a unit code, a warehouse name, a party in the
     projection;
   - duplicates inside the file (document, SKU, unit code) are refused after their first
     line.

   A write can still refuse a valid row, for example a document registered meanwhile.
   That row becomes a failure with the use case's reason.
5. **Writing exactly once.** A row's key is `(job, line)`.
   - **Parties, Catalog, Inventory.** The row is marked `written` in the same transaction
     as the use case's write, through a decorated unit of work. The mark is conditional on
     the row still being `valid`. If another worker, or a cancellation, got there first,
     the whole write rolls back.
   - **Financial.** The draft and the post are `once` commands keyed by
     `import:<job>:<line>:draft` and `…:post`. A resume replays them without writing again,
     and the row is marked afterwards.
   - **Processing.**
     - Batches of `IMPORT_BATCH_SIZE` (100) rows in line order.
     - The job holds a lease (`IMPORT_LEASE_MS`, 60 s), renewed each batch, claimed with
       `FOR UPDATE SKIP LOCKED`.
     - A worker finds tenants with running jobs as the relay role, which reads only
       `tenant_id`, `status` and `lease_until`.
   - **Cancellation** marks every row still `valid` as `cancelled`, and the job
     `cancelled`, in one transaction.
6. **What each importer writes, and through what:**
   - **`parties`:** `RegisterPartyUseCase`.
     - The columns are kind, document type and number (or country for a foreign one),
       legal name, trade name, email, phone, address, and roles separated by `|`.
     - A document already registered is a failure that says to grant the role instead.
   - **`units`:** `CreateUnitUseCase`.
   - **`items`:** `CreateCatalogItemUseCase`, with the unit resolved by code.
   - **`prices`:** `SetPriceUseCase`.
     - The price list is resolved by name and the item by SKU.
     - A missing list is created with `CreatePriceListUseCase` before the price is set.
   - **`opening-stock`:** `ReceiveStockUseCase`.
     - The warehouse is given by name. The item is given by id: Inventory does not know
       SKUs, and a Catalog items list export carries both.
     - A lot and its expiry, or serials separated by `|`, are optional. The item's
       tracking policy decides which it needs.
   - **`receivables` and `payables`:** `DraftTitleUseCase`, then `PostTitleUseCase`.
     - The party is given by id, and must be in the projection with the right role.
     - One row is one title with a single installment.
     - An imported payable above the approval threshold waits for approval, like any
       other: an import is not a way around a control.
7. **Roles.** Importing, and reading import jobs, is an administrator's work in each
   module: Parties `admin`, Catalog `admin`, Inventory `admin`, Financial `admin`. The
   rows are written with the importer as the actor, so audit logs name them.
8. **Stored rows and retention.**
   - `import_jobs` and `import_rows`, with forced RLS.
   - A row keeps its source values, which the failures file needs, and its state,
     reasons and the reference it wrote.
   - **In Parties the values are personal data.** They are sealed with a key per job,
     held in the job row.
   - **When a job ends:**
     - the values of written and cancelled rows are cleared;
     - failed rows keep theirs for `IMPORT_RETENTION_HOURS` (72), then the worker clears
       them and, in Parties, destroys the job's key.
     - After that the failures file answers `410`.
9. **The failures file.**
   - It has the same format and separator as the input, the original header, and two
     more columns: `line` and `reason`, with the reasons joined by `; `.
   - A text cell that is not a plain number and starts with `=`, `+`, `-`, `@`, a tab or a
     carriage return is prefixed with `'`.
10. **The web wizard.**
    - One screen, `/app/imports`:
      - choose the module and the kind;
      - upload;
      - map;
      - see the preview;
      - confirm;
      - follow the progress (polled);
      - download the failures.
    - The job key is the SHA-256 of the file and the kind, so sending the same file twice
      finds the same job.
    - A list of the module's recent jobs sits under the wizard.
    - It works with any module listed as importing, and asks the module for its kinds and
      fields, so a fifth importer needs no new screen.

## Work

### A — Contracts

1. `http/imports.ts`: the states, the progress and its invariant, the job, field, upload,
   mapping, preview and error shapes, and the limits.
2. Unit tests of the invariant and the shapes.
3. Release 0.47.0, then repin every consumer.

### B — The engine, per module (Parties first, then copied)

1. **Domain:**
   - `import-job.ts`: the states, transitions and progress;
   - `tabular.ts`: CSV and XLSX reading, and locale numbers and dates;
   - the mapping suggestion.
2. **Application:**
   - `UploadImport`, `MapImport`, `PreviewImport`, `ConfirmImport` and `CancelImport`;
   - `ProcessImports` (batches, lease, finish);
   - `ExpireImports`;
   - the `RowImporter` port (fields, validate, write).
3. **Infrastructure:**
   - migration `import_jobs` and `import_rows`, with relay scan grants;
   - the store;
   - the decorated unit of work;
   - the failures writers (CSV and XLSX);
   - the worker;
   - `imports.controller.ts`.
4. **Tests:**
   - unit tests of the domain and application;
   - **e2e:**
     - a file with valid and invalid rows;
     - the counts add up to the file's rows;
     - the failures file read back;
     - a worker stopped mid-job and a second one finishing, with every row written
       once;
     - the same key twice;
     - cancel;
     - cross-tenant reads;
     - the relay role refused the row content;
     - a user without the role refused.

### C — The importers

The importers of section 6, each with unit tests of its validation and an e2e test that
compares an imported row with the same command sent through the API.

### D — Web

1. `features/imports/`: the wizard and the job list, with its labels in pt-BR and English.
2. `lib/import-file.ts`: reading a file into the upload body and its key, with unit
   tests.
3. The navigation entry "Importações" under Administration.

### E — Platform and evidence

1. **Compose:** the import settings of the four services, and the body limit.
2. `scripts/phase64-smoke.mjs`, through Kong:
   - one file per kind, with valid and invalid rows;
   - the counts add up and the failures download;
   - the same key twice writes nothing;
   - Parties is killed mid-import and restarted, and every row is written once;
   - a user without the role gets `403`.
3. The API documents of the four modules, the glossary, and the evidence record.

## Exit evidence

- `make check` and the local CI pass.
- Killing the service mid-import and restarting it finishes with every row written once.
- A file with invalid rows imports the valid ones, and reports every invalid one with its
  line and reason.
- The totals on the screen always add up to the file's row count.
- Importing the same file twice with the same job key writes nothing new.

## Revisions made while implementing

- **Financial needs a category.** A title posts only classified, so `category` (by code)
  is a required field of `receivables` and `payables`. It is resolved when the row is
  written.
- **A held payable is asked for approval, not posted.** When the approval policy holds a
  payable, the importer drafts it and requests approval. The row is written with the
  request, and a second person approves and posts. A row the post refuses withdraws its
  draft.
- **Financial marks its row inside the post, or the approval request.** It no longer marks
  after it, so a cancellation can never leave a posted title behind a cancelled row.
- **Leading zeros.** An NCM of seven digits, and a CPF or CNPJ missing up to three zeros,
  get them back: spreadsheets store them as numbers. The XLSX writer keeps a value with a
  leading zero as text.
- **Validation lookups are loaded once per pass:**
  - Catalog's units and price lists;
  - Inventory's warehouses (`WarehousesRepository.list()` is new).

  Lookups a module cannot list (an SKU when setting a price, a party or a category in
  Financial) are checked when the row is written, and refuse it there.
- **A job with no failures forgets its rows when it ends.** A job left unconfirmed is
  cancelled after the retention.
- **The upload skips Catalog's idempotency interceptor.** The job key is the job's own
  idempotency, and an 8 MB body does not belong in the response cache.

## Out of scope

- **Resolving another module's identifiers by a business key.** An SKU in Inventory, or a
  document in Financial, would need a projection those modules do not keep. The
  identifiers come from the owning module's list export (Phase 63).
- **Updating existing records by import.** An import only creates.
- **Titles with several installments, and settlements.** An open title at go-live is
  imported as what is still owed, in one installment.
- **Opening balances in the ledger.** Posted titles reach the ledger as any title does.
  A separate opening journal entry is the accountant's, by hand.
- **Notifications when an import ends,** and the job centre (Phase 66).
