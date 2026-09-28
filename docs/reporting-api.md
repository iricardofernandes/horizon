# Reporting API reference

The reporting module lives in `reporting/`
([ADR 0047](adr/0047-reporting-projections-never-write-back.md),
[ADR 0058](adr/0058-reporting-keeps-a-sealed-event-journal.md),
[production readiness plan](production-readiness-implementation-plan.md)).
- **Paths:** through Kong every path below is prefixed with `/reporting`.
- **Formats:** amounts are minor units as decimal strings, per currency, and never
  converted. Instants are ISO 8601 with an offset. Months are `YYYY-MM` in UTC.

## Roles

| Action | Roles |
|---|---|
| `read` | `admin`, `analyst`, `viewer` |
| `reconcile` | `admin`, `analyst` |
| `save` | `admin`, `analyst` |
| `share` | `admin` |
| `export` | `admin`, `analyst`, `viewer` |
| `schedule` | `admin`, `analyst` |
| `administer` (see everyone's exports and schedules) | `admin` |

**Errors:**
- `400` for invalid input;
- `403` for a role that may not act;
- `404` for an unknown report or filter;
- `409` for a reconciliation at an unsettled cutoff, or an `Idempotency-Key` reused for
  another request.

## Sources

| Method | Path | Action | What it answers |
|---|---|---|---|
| `GET` | `/sources?cutoff=` | read | Per journaled module: events held, the latest, the watermark, the last seal, and whether the cutoff is settled; and whether it is settled for all of them |

A producer resends its history and seals it with
`npm run republish:journal -- --tenant <uuid>`, run in the producer's own container.
Every producer also seals every tenant by itself every `JOURNAL_SEAL_INTERVAL_MS` (five
minutes by default).

## Reports

| Method | Path | Action | What it answers |
|---|---|---|---|
| `GET` | `/reports` | read | The catalogue: each report's sources, checks and derived figures |
| `GET` | `/reports/{name}?cutoff=&currency=&from=&to=&filterId=` | read | The report at the cutoff (default now) |
| `GET` | `/dashboard?cutoff=` | read | The headline of every report, all at one cutoff |

**Every report answers:**
- `cutoff`;
- `settled`, which is true when every source it reads is sealed through the cutoff;
- `sources`, with each source's watermark;
- `filter`, `data`, `checks` and `derived`;
- `reconciliation`, the latest run at exactly that cutoff.

**Filters:**
- `currency` narrows every figure.
- `from` and `to` (months) narrow flows: what was shipped, raised, settled, received or
  closed in those months. They never narrow positions: open orders, open titles and
  balances.
- `filterId` applies a saved filter the caller can see.

| Report | Sources | `data` |
|---|---|---|
| `cash-position` | financial, treasury | `receivables` and `payables`: open per currency; `accounts`: balance of each treasury account |
| `order-to-cash` | sales, financial, treasury | per currency: `confirmed` orders (count, total), `cancelledAfterConfirmation`, `shipped`, `returned`, `receivables` raised from sales (`raised`, `settled`, `open`), `bankReconciled` |
| `procure-to-pay` | procurement, financial | per currency: `committed` orders (count, total), `cancelledAfterApproval`, `received`, `returns`, `payables` raised from purchasing (`raised`, `settled`, `open`) |
| `pipeline-to-revenue` | crm, sales | `months`: per month closed and currency, `won`, `lost` and `converted` (count, value); `quotesAccepted` with an attribution, per currency |

## Reconciliation

| Method | Path | Action | Key | What it does |
|---|---|---|---|---|
| `POST` | `/reports/{name}/reconciliations` | reconcile | yes | `{ cutoff? }`: compares the report with its owners at a settled cutoff, and stores the run |
| `GET` | `/reports/{name}/reconciliations?limit=` | read | | The latest runs |

**How owners are read:**
- Owners are read through the gateway with the caller's own token. The caller needs read
  access in each owning module; without it, that check is `forbidden`.
- An owner that answers the current state (Financial, Treasury, Sales, Procurement) is
  compared only when the journal holds nothing of that module after the cutoff. This is
  checked before and after reading it. The CRM forecast answers as of the cutoff, so it is
  always compared.

| Check | Report figure | Owner |
|---|---|---|
| `receivables-outstanding` | cash position: open receivables | `GET /financial/receivables/summary` |
| `payables-outstanding` | cash position: open payables | `GET /financial/payables/summary` |
| `account-balances` | cash position: account balances | `GET /treasury/accounts` (`projectedBalance`) |
| `orders-confirmed` | order to cash: confirmed orders | `GET /sales/orders/summary` |
| `orders-committed` | procure to pay: committed orders | `GET /procurement/orders/summary` (approved, received or closed) |
| `won-by-month` | pipeline to revenue: won by month | `GET /crm/forecast?cutoff=` |

**Outcomes:**
- a run is `matched`, `different`, or `not-comparable`;
- each check says its outcome, the differences (`key`, `reported`, `owner`), or why it
  could not be made: `unsettled`, `moved-after-cutoff`, `owner-unavailable` or
  `forbidden`.

```http
POST /reporting/reports/cash-position/reconciliations
Idempotency-Key: 5d0e…
{ "cutoff": "2026-09-27T20:19:26.792Z" }

201 { "runId": "0199…", "report": "cash-position", "cutoff": "2026-09-27T20:19:26.792Z",
      "outcome": "matched",
      "checks": [{ "check": "receivables-outstanding", "outcome": "matched" }, …],
      "startedBy": "…", "startedAt": "…" }
```

## Saved filters

| Method | Path | Action | Key | What it does |
|---|---|---|---|---|
| `GET` | `/saved-filters?report=` | read | | The caller's own filters and the shared ones |
| `POST` | `/saved-filters` | save (+ share for `shared`) | yes | `report`, `name` (1–80), `filter` (`currency`, `from`, `to`), `shared` |
| `PATCH` | `/saved-filters/{id}` | save | | `name`, `filter`, `shared` (sharing needs `share`) |
| `DELETE` | `/saved-filters/{id}` | save | | Removes it |

A filter is changed or removed by its owner, or, when shared, by an administrator.
Changes are audited in reporting's hash-chained audit log.

## Exports (Phase 63)

| Method | Path | Action | Key | What it does |
|---|---|---|---|---|
| `POST` | `/exports` | export | yes | `report`, `format` (`csv`, `xlsx`), `locale` (`pt-BR`, `en`), optional `cutoff`, `filter` or `filterId`: `202` with the job, `requested` |
| `GET` | `/exports?limit=` | export | | The caller's exports (everyone's for an administrator) |
| `GET` | `/exports/{id}` | export | | One export: `status` (`requested`, `running`, `ready`, `failed`, `expired`), `settled`, `rows`, `bytes`, `sha256`, `expiresAt` |
| `GET` | `/exports/{id}/link` | export | | `{ url, expiresAt }`: a link valid for 15 minutes to a `ready` file |
| `GET` | `/exports/{id}/file?tenant=&expires=&signature=` | public, signed | | The file, with `Content-Disposition` and `Digest: sha-256=…` |
| `POST` | `/export-schedules` | schedule | yes | `report`, `format`, `locale`, `cadence` (`daily`, `weekly` on Mondays, `monthly` on the 1st), `timeZone` (IANA), `filter` or `filterId`, optional `since` (at most 31 days back) |
| `GET` | `/export-schedules` | schedule | | The caller's schedules (everyone's for an administrator) |
| `PATCH` | `/export-schedules/{id}` | schedule | | `{ active }`: pause, or resume and catch up |
| `DELETE` | `/export-schedules/{id}` | schedule | | Removes it; the runs it made stay |

**The file.**
- It starts with metadata rows (`report`, `cutoff`, `settled`, `filter`, `generated_at`,
  `locale`, and `schedule` for a scheduled run), then a blank row, then the table.
- Amounts are decimal amounts of their currency, and column names are machine names.
- **CSV** is UTF-8 with a BOM: `;` and a decimal comma in pt-BR, `,` and a decimal point
  in English.
- **XLSX** has one sheet, with numbers as numbers.
- **Formula injection:** a text cell starting with `=`, `+`, `-`, `@`, a tab or a carriage
  return is prefixed with `'` in both formats.

**Scheduled runs.**
- A scheduled run's cutoff is its due instant, local midnight in the schedule's timezone.
- It waits for that cutoff to settle for the report's sources, up to
  `EXPORT_SETTLE_GRACE_MS`. After that it runs, marked `settled: false`.
- Missed instants are each run once, in order.

**Retention.** Files are removed `EXPORT_RETENTION_HOURS` after they are written, and the
job becomes `expired`.

## List exports (web)

`GET /api/export/<module>/<list path>?<the list's own query>&locale=pt-BR|en`, on the web
server:
- it pages the list as the signed-in user and returns CSV, up to 50,000 rows;
- the metadata rows are `list`, `exported_at`, `filter`, `rows`, and `truncated_at` when
  cut;
- a user without read access gets the module's `403`, and no file.

It follows the three paging styles the modules use:
- `page.total`;
- a top-level `total`;
- `page.nextCursor`.

A bare array is exported as one page.

## Owner summaries (Phase 62)

| Method | Path | Module | What it answers |
|---|---|---|---|
| `GET` | `/sales/orders/summary` | sales, read | Orders by status and currency: count and total |
| `GET` | `/procurement/orders/summary` | procurement, read | Purchase orders by status and currency: count and total |

## Notifications (Phase 66)

These routes need only a token: no Reporting role. A notification holds ids, counts and
statuses, never a name, and the web renders its text in the reader's language.

| Route | Does |
|---|---|
| `GET /notifications?limit=` | the latest notifications for the reader (up to 100), each with `read` |
| `GET /notifications/unread-count` | `{ unread }` |
| `POST /notifications/{id}/read` | marks one read for the reader; `{ marked }` |
| `POST /notifications/read-all` | marks everything the reader can see read |

- **Who sees one.**
  - A notification addressed to a user is theirs.
  - One addressed to a role is shown to whoever holds that role in the module when they
    read it, except the person whose own request it is.
  - Read state is per person.
- **Once per event.** A notification is unique on `(tenant, source event, kind, recipient)`.
  A redelivered or republished event inserts nothing. Replays of history go to the
  journal's replay queue, which never notifies.

| Kind | From | For |
|---|---|---|
| `task-due` | `crm.task.due` | the assignee |
| `approval-requisition` | `procurement.requisition.submitted` | procurement `admin` and `approver`, except the submitter |
| `approval-order` | `procurement.order.placed` with `approvalRequired` | procurement `admin` and `approver`, except the buyer |
| `approval-payable` | `financial.payable.approval-requested` | financial `admin`, except the requester |
| `import-finished` | `parties\|catalog\|inventory\|financial.import.finished` | whoever uploaded the file |
| `billing-run-finished` | `sales.billing-run.finished` | whoever started the run |
| `file-quarantined` | `files.attachment.quarantined` | the uploader |
| `export-finished` | an export of Reporting ending, ready or failed | whoever asked for it |
| `reconciliation-different` | a reconciliation run with differences | whoever started it |

## Saved views (Phase 66)

These routes need only a token. A view holds a list screen's query string (its filters)
and, where the screen allows, its visible columns.

| Route | Does |
|---|---|
| `GET /views?screen=` | the reader's own views and the shared ones |
| `POST /views` | `{ screen, name, query, columns?, shared? }`; `409` for a name the owner already uses there |
| `PATCH /views/{id}` | renames, changes or shares; the owner only (`403` otherwise) |
| `DELETE /views/{id}` | the owner only |

- **The fields.** `screen` is `<module>.<list>`, such as `financial.payables` or
  `crm.accounts`. `query` has no leading `?`, and is at most 1,000 characters.
- **Visibility.** Another person's private view answers `404`.
