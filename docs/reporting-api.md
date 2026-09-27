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

## Owner summaries (Phase 62)

| Method | Path | Module | What it answers |
|---|---|---|---|
| `GET` | `/sales/orders/summary` | sales, read | Orders by status and currency: count and total |
| `GET` | `/procurement/orders/summary` | procurement, read | Purchase orders by status and currency: count and total |
