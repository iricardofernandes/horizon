# Imports API reference

Bulk imports are jobs inside the module that owns the data
([ADR 0059](adr/0059-bulk-data-jobs-belong-to-the-owning-module.md),
[Phase 64 plan](readiness-phase64-implementation-plan.md)). Parties, Catalog, Inventory and
Financial implement the same contract, whose shapes are published in `@horizon/contracts`
0.47.0 (`http/imports.ts`).
- **Paths:** through Kong every path below is prefixed with the module: `/parties`,
  `/catalog`, `/inventory` or `/financial`.
- **Role:** every route needs the module's `admin` role. Rows are written with the
  uploader as the actor, so audit logs name them.
- **Limits:** 10,000 rows and 5 MB per file.

## Routes

| Route | Does |
|---|---|
| `GET /imports/kinds` | the kinds this module imports, with their fields |
| `POST /imports/{kind}` | uploads a file; `201` a new job, `200` the same job again |
| `GET /imports?kind=` | the 50 most recent jobs |
| `GET /imports/{id}` | one job and its progress |
| `PUT /imports/{id}/mapping` | maps fields to columns and validates every row |
| `POST /imports/{id}/preview` | the counts, the first 50 errors and the first 10 valid rows |
| `POST /imports/{id}/confirm` | `202`; a worker starts writing |
| `POST /imports/{id}/cancel` | stops the job; unwritten rows are cancelled |
| `GET /imports/{id}/failures` | the failed rows in the input's format; `410` after retention |

## Upload

```http
POST /parties/imports/parties
Idempotency-Key: 9f2c…            # the job key: required
Content-Type: application/json

{ "fileName": "clientes.csv", "format": "csv", "locale": "pt-BR", "content": "Tipo;Razão Social;…" }
```

- **`content`** is the text of a CSV, or the base64 of an XLSX (first sheet).
- **CSV:**
  - UTF-8 or Windows-1252, with or without a BOM;
  - the separator (`;`, `,` or a tab) is read from the header line;
  - RFC 4180 quoting.
- **`locale`:**
  - it decides how a CSV writes numbers (`1.234,56` or `1,234.56`) and dates (`DD/MM/YYYY`
    or `MM/DD/YYYY`; `YYYY-MM-DD` always works);
  - XLSX numbers are read as numbers.
- **The job key.** The same key with the same bytes returns the same job, and nothing is
  written again. The same key with other bytes is `409`.
- **The header row.** It names every column, once each. The server suggests a mapping from
  the header names.

## States and progress

`uploaded → validated → previewed → running → completed | completed-with-failures | cancelled`

- A new mapping sends a `validated` or `previewed` job back to `validated`.
- Only a `previewed` job can be confirmed.

```json
"progress": { "total": 1503, "valid": 1500, "written": 1500, "failed": 3, "remaining": 0, "cancelled": 0 }
```

- `total = written + failed + remaining + cancelled`, always.
- `failed` counts the rows refused by validation and those the use case refused when
  writing.
- A job is `completed` only when every row was written.
- **Retention.**
  - A job without failures forgets its rows' values when it ends.
  - Failed rows are kept until `failuresUntil` (72 hours), then cleared, and the failures
    file answers `410`.
  - A job left unconfirmed for 72 hours is cancelled.

## Writing exactly once

A row's key is the job and its line.
- **Parties, Catalog and Inventory** mark the row written in the same transaction as the
  use case's write. If the row was cancelled, or taken by another worker, the write rolls
  back.
- **Financial** drafts and posts through `once` commands keyed
  `import:<job>:<line>:draft` and `…:post`, and marks the row inside the post.
- **The worker.**
  - It finds tenants with work as the relay role, which reads only scan columns.
  - It holds a job with a lease of 60 seconds.
  - A job whose worker died is taken over when the lease lapses, from its first row not
    yet written.

## Kinds

Fields marked * are required. Every field also accepts common pt-BR and English header
names.

| Module | Kind | Fields | Written through |
|---|---|---|---|
| Parties | `parties` | kind* (organization/person, PJ/PF), legalName*, tradeName, documentType, documentNumber, documentCountry, email, phone, address, roles (`\|`-separated) | `RegisterPartyUseCase` |
| Catalog | `units` | code*, name*, decimalPlaces | `CreateUnitUseCase` |
| Catalog | `items` | sku*, name*, kind, unit* (code), ncm | `CreateCatalogItemUseCase` |
| Catalog | `prices` | priceList* (name), currency*, sku*, price* | `CreatePriceListUseCase` when missing, then `SetPriceUseCase` |
| Inventory | `opening-stock` | warehouse* (name), itemId*, quantity*, unitCost*, currency*, lot, expiresOn, serials (`\|`-separated) | `ReceiveStockUseCase` |
| Financial | `receivables`, `payables` | partyId*, documentNumber*, description, issuedOn*, dueOn*, amount*, currency*, category* (code) | `DraftTitleUseCase`, then `PostTitleUseCase` |

Notes per module:
- **Parties.**
  - A document is inferred from the kind when its type is left out (CPF for a person, CNPJ
    for an organization).
  - A CPF or CNPJ a spreadsheet stored as a number gets back up to three leading zeros.
  - A document already registered is refused with "grant it the role instead".
  - The rows are personal data: they are sealed under a key per job, which is destroyed
    with them.
- **Catalog.** An NCM that lost its leading zero is restored. Prices are decimals of the
  list's currency; more decimals than the currency has are refused.
- **Inventory.** Items are given by id: Inventory does not know SKUs, and a Catalog items
  export carries both.
- **Financial.**
  - One row is one title with one installment of what is still owed.
  - The party must be in Financial's projection with the right role.
  - A payable the approval policy holds is drafted and its approval requested, never
    posted. A second person approves and posts it.
  - A row the post refuses withdraws its draft.
