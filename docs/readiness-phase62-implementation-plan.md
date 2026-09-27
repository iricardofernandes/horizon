# Phase 62 — Cross-domain reports reconciled at a cutoff

Status: **delivered on 2026-09-27** ([evidence](readiness-phase62-evidence.md)). This is the execution record for
[Phase 62 of the production readiness plan](production-readiness-implementation-plan.md#62--cross-domain-reports-reconciled-at-a-cutoff).
Decision: [ADR 0058](adr/0058-reporting-keeps-a-sealed-event-journal.md).

## Result

After this phase:
- **Four reports** are read at a cutoff:
  - cash position;
  - order to cash;
  - procure to pay;
  - pipeline to revenue.

  Each says its cutoff, the sources it reads and whether the cutoff is settled for them.
- A dashboard gives the headline figure of each.
- **Reconciliation:**
  - each report is compared with its owning modules' own reports;
  - the run is stored with every difference, and says when a figure could not be
    compared and why.
- A person saves report filters for themselves or, as an administrator, for the workspace.
- **Seals and replay:**
  - every producer the reports read seals its tenants on a schedule, so cutoffs settle
    without anyone running a command;
  - CRM can resend its history like the other six producers.

## Starting point

- The journal holds every event of the reported modules, and seals prove how far
  (Phase 61).
- **Owning reports that answer as of an instant:** only the CRM forecast
  (`/crm/forecast?cutoff=`) and the inventory valuation (`asOf`).
- **Owning reports that answer the current state:**
  - Financial's summaries (`/financial/{receivables,payables}/summary`);
  - Treasury's balances (`/treasury/accounts`).
- **No aggregate:** Sales and Procurement have no aggregate of their orders. Their lists
  are pages of up to 100.
- **No service identity:** a module has no token of its own to call another. The only
  service token is Fiscal's, from its own API key.

## Decisions frozen by this plan

1. **A report is a query over the journal, at the cutoff.**
   - Each figure is computed at read time from the journal rows that occurred up to the
     cutoff, with the order of facts taken from `occurred_at`, never from arrival.
   - There are no projection tables, so nothing can drift from the journal, and there is
     nothing to rebuild.
   - A materialized projection arrives when a report's read time needs one. The smoke
     measures each report's read time.

   This revises the Phase M plan: `rebuild:reports` is dropped, and "a hand-edited
   projection row" becomes "a journal row cannot be edited, and a missing one shows as a
   seal mismatch".
2. **The four reports and their sources:**

   | Report | Sources | Figures |
   |---|---|---|
   | `cash-position` | financial, treasury | open receivables and payables per currency; each treasury account's balance |
   | `order-to-cash` | sales, financial, treasury | orders confirmed and cancelled; value shipped and returned; receivables raised from sales, settled and still open; money reconciled in the bank |
   | `procure-to-pay` | procurement, financial | orders committed and cancelled; value received and returned; payables raised from purchasing, paid and still open |
   | `pipeline-to-revenue` | crm, sales | opportunities won and lost by month closed; converted by a quote; quotes accepted with an attribution |

   - Every figure is per currency. Amounts are never converted.
   - A report can be narrowed by currency, and its flows by the months they occurred in
     (`from`, `to`).
3. **Every figure is either reconciled against an owner, or says why not.**

   | Check | Report figure | Owner report |
   |---|---|---|
   | `receivables-outstanding` | cash position: open receivables per currency | `GET /financial/receivables/summary` |
   | `payables-outstanding` | cash position: open payables per currency | `GET /financial/payables/summary` |
   | `account-balances` | cash position: balance per account | `GET /treasury/accounts` (`projectedBalance`) |
   | `orders-confirmed` | order to cash: confirmed orders, count and total per currency | `GET /sales/orders/summary` (new) |
   | `orders-committed` | procure to pay: committed orders, count and total per currency | `GET /procurement/orders/summary` (new) |
   | `won-by-month` | pipeline to revenue: won count and value per month and currency | `GET /crm/forecast?cutoff=` (the same cutoff) |

   - Figures with no owner aggregate are marked `derived`, with the owner they come from:
     - receivables raised from sales, settled and open, which cash position reconciles in
       total;
     - value shipped and received;
     - bank reconciliation;
     - conversions.
   - **Comparing with an owner that answers the current state.** Such an owner describes
     the cutoff only if nothing happened in that source after it.
     - A check against such an owner is `not-comparable` when the journal holds an event
       of that source after the cutoff. It is checked before and after the owner is
       read.
     - The CRM forecast answers as of the cutoff, so its check is always comparable.
   - **A run** is `matched`, `different` (with each difference), or `not-comparable`
     (with the reason: `unsettled`, `moved-after-cutoff`, `owner-unavailable` or
     `forbidden`).
   - A run is refused on an unsettled cutoff.
4. **Reconciliation reads the owners as the person who asks.**
   - `POST /reports/{name}/reconciliations` forwards the caller's bearer token to the
     gateway (`GATEWAY_URL`), for the owners' `GET` routes only. It never stores or logs
     the token.
   - The caller needs `reconcile` in reporting (`admin`, `analyst`) and read access in each
     owning module. A missing one makes that check `forbidden`.
   - Scheduled reconciliation needs a service identity, which the consistency checks of
     Phase 69 introduce, so it moves there.
5. **Owner aggregates.** Sales and Procurement gain a summary of their orders by status and
   currency. It is the owner's own report (ADR 0047: a report stays with the module that
   owns its data).
6. **Scheduled seals.**
   - Each producer the reports read runs a seal worker next to its outbox relay. Every
     `JOURNAL_SEAL_INTERVAL_MS` (default five minutes), it seals every tenant that has
     outbox rows, through two minutes ago.
   - A missing replay queue (reporting not running) is logged and retried. It never
     stops the relay.
   - The producers are Sales, Financial, Treasury, Procurement and CRM, plus Inventory
     and Ledger, which have `republish:journal` already. CRM also gains
     `republish:journal`.
7. **Saved filters.**
   - A saved filter holds a report, a name and its filter (currency, from, to).
   - It is private to its owner, or shared with the workspace. Only `admin` shares.
   - Creating one needs an `Idempotency-Key`.
   - Changes are audited in reporting's own hash-chained audit log (ADR 0025).
8. **Roles:**

   | Action | Roles |
   |---|---|
   | `read` | `admin`, `analyst`, `viewer` |
   | `reconcile` | `admin`, `analyst` |
   | `save` | `admin`, `analyst` |
   | `share` | `admin` |

## Work

### A — Reporting

1. **The domain:**
   - the report catalogue (name, sources, checks);
   - the figure comparison;
   - the comparability rule;
   - the filter and cutoff values.

   All of it is covered by unit tests.
2. **The application:**
   - `ReadReport`, which gives the figures, the settlement and the latest run at that
     cutoff;
   - `Dashboard`;
   - `RunReconciliation`;
   - `ManageSavedFilters`;
   - the ports `ReportReads`, `OwnerReports`, `ReconciliationRuns` and `SavedFilters`.
3. **The infrastructure:**
   - the SQL of each report over the journal;
   - the gateway client for owner reports;
   - migration `0001_reports.sql`: `saved_filters`, `reconciliation_runs`,
     `reconciliation_differences`, `command_receipts` and `audit_log`, with forced RLS
     and the audit and run history append-only;
   - the controllers.
4. **The e2e suite:**
   - each report from journaled events, including out-of-order arrival and a reversed
     settlement;
   - a late event after a settled cutoff;
   - a run that matches, one that differs and one that is not comparable, with a fake
     owner;
   - saved filters and their roles;
   - cross-tenant reads.

### B — Owners and producers

1. `GET /sales/orders/summary` and `GET /procurement/orders/summary`, each with an e2e
   test.
2. **The seal worker** in Sales, Financial, Treasury, Inventory, Procurement, Ledger and
   CRM, with an e2e test in one producer.
3. **CRM:** `journal-replay.ts`, `republish:journal` and its e2e test.

### C — Evidence

1. `scripts/phase62-smoke.mjs`, on the local stack:
   - every producer resends and seals;
   - the four reports are read at the settled cutoff, and every check is `matched`;
   - an opportunity won afterwards changes the report at now, but not at the settled
     cutoff;
   - a run at an unsettled cutoff is refused;
   - saved filters work;
   - a viewer cannot reconcile;
   - each report's read time is recorded.
2. `docs/reporting-api.md`, and the glossary entry for reconciliation run.

## Exit evidence

- `make check` and the local CI pass.
- The smoke passes twice: the local stack's history reconciles to zero difference in every
  check.
- A late event after a settled cutoff never changes it.
- A journal row cannot be changed, and a gap shows as a seal mismatch (Phase 61).

## Revisions made while implementing

- **Runs keep their checks in the run row** (`checks`, JSON), not in a separate
  differences table. A run is read and kept whole, and the row is append-only by trigger.
- **A title's open amount is its latest settlement fact's `outstanding`,** or its total
  before any settlement. That is what Financial publishes after each settlement or
  reversal, so the report never recomputes interest or discount rules.
- **An owner's summary counts what it holds now.**
  - Sales: `confirmed` orders.
  - Procurement: `approved`, `received` and `closed` orders.

  A placed sales order has a total of zero until Inventory confirms it, so it appears in
  the summary but never in the report.

## Out of scope

- **Scheduled reconciliation** (Phase 69, with a service identity).
- **Stock against the ledger** (Phase 69's consistency checks), which needs the inventory
  accounts' mapping and the valuation method.
- **Fiscal documents in order to cash.** Fiscal is not sealed yet, so every report reading
  it would stay unsettled.
- **Screens** (Phase 70).
