# Horizon — operational ERP expansion plan

This plan defines the work required to move Horizon from its current demonstrator scope
to a broad operational ERP comparable to Omie's core surface. It is a product and
architecture baseline, not a claim of exact feature parity, a visual clone, or certified
tax/accounting compliance.

The implementation order is dependency-driven. Financial documents cannot be reliable
before shared parties and classification dimensions exist; bank reconciliation cannot be
reliable before payables, receivables and bank transactions have immutable identities;
fiscal automation cannot be reliable before sales and purchasing lifecycles are complete.

## Reference baseline

The comparison baseline is Omie's public product and developer documentation as reviewed
on 2026-09-15:

- The [Omie API catalog](https://developer.omie.com.br/service-list/) groups shared
  registrations, CRM, finance, purchasing/stock/production, sales/NF-e, services/NFS-e
  and accounting-facing documents.
- The [Finance checklist](https://ajuda.omie.com.br/pt-BR/articles/499120-checklist-do-modulo-de-financas)
  includes current accounts, opening balances, payables, receivables, statements,
  reconciliation, cash budget, cash flow and DRE.
- The [current-account documentation](https://ajuda.omie.com.br/pt-BR/collections/89994-contas-correntes)
  includes entries, transfers, manual and imported-statement reconciliation and matching
  one statement line against several ERP entries.
- The [Purchasing, Inventory and Production checklist](https://ajuda.omie.com.br/pt-BR/articles/499169-checklist-do-modulo-compras-estoque-e-producao)
  covers suppliers, purchase requests, purchase orders, approvals, inbound invoices,
  returns, purchase suggestions and production orders.
- The [Sales and NF-e checklist](https://ajuda.omie.com.br/pt-BR/articles/499116-checklist-de-implantacao-vendas-e-nf-e)
  connects sales orders to receivable forecasts, invoicing, stock deductions and effective
  receivables.
- The [Services and NFS-e checklist](https://ajuda.omie.com.br/pt-BR/articles/499118-checklist-do-modulo-servicos-e-nfs-e)
  covers service catalogues, service orders, recurring contracts, receipts and NFS-e.
- The [CRM checklist](https://ajuda.omie.com.br/pt-BR/articles/499117-checklist-do-modulo-crm)
  covers accounts, contacts, opportunities, tasks, pipelines and reports.

This baseline should be revisited at the start of each major release. Horizon should copy
business capability, not Omie's internal implementation or interface.

## Current baseline and gaps

| Capability | Current Horizon state | Gap |
|---|---|---|
| Account, workspaces, users and RBAC | Implemented | Invitations, MFA, user preferences and richer audit UI |
| Catalog | Basic products/services, units, NCM, price lists | Editing, families, variants, kits/BOM, attachments, tax and supplier data |
| Customers | Create/list/erase inside `sales/` | No shared party model, suppliers, contacts, addresses, tags or editing |
| Quotes and sales orders | Basic create/list/detail/accept flow | Amendments, cancellation, approval, payment schedule, fulfilment, returns and invoicing |
| Inventory | Warehouses, receipt, balances and reservation choreography | Transfers, adjustments, Kardex, count, min/max, lots/serials and valuation reports |
| Webhooks and API keys | Implemented but split between Operations and Settings | Unified Developers area, API documentation, logs, testing and usage visibility |
| Finance | Declared only in `roadmap.md` | Entire subledger, treasury, reconciliation and reporting surface |
| Purchasing | Not implemented | Suppliers through goods receipt, approval and payable generation |
| Fiscal | Declared only in `roadmap.md` | NF-e/NFS-e lifecycle, inbound XML and tax rules |
| Services | Catalog can mark an item as a service | Service orders, execution, contracts, recurrence and service invoicing |
| CRM | Not implemented | Accounts, contacts, opportunities, tasks and pipeline |
| Reporting | Operational overview only | Financial, sales, purchasing, inventory, audit and export reports |
| Localization | UI strings are hard-coded in English | Complete `pt-BR` and English localization and locale-aware formatting |

### Frontend baseline in detail

The gap in the application shell is larger than the table suggests, so it is stated
explicitly. Today the authenticated product is one client component:

- `web/src/app/app/page.tsx` is a single 1,200-line `'use client'` file that holds a
  nine-value `view` union, the navigation array, orders, webhooks, deliveries, dialog
  state and every fetch for those screens.
- `web/src/features/` contains six view components — access, catalog, inventory,
  sales/customers, sales/quotes and settings — each fetching and rendering its own data.
- `web/src/components/ui/` contains three primitives: button, text field and select field.
- Below `/app` there are no route segments, so no screen is bookmarkable, no screen has a
  `loading.tsx` or `error.tsx`, and back/forward do not move between screens.
- Navigation is filtered only by the hosted-demo flag, not by the signed-in user's module
  roles, so an action a user cannot perform is still offered to them.
- Every string, label, enum value, empty state and validation message is inline English.

Phase A converts this into routed feature pages, a permission-driven navigation registry,
a shared data layer and a translated message catalogue. Every later phase assumes that
shape exists; adding Finance, Purchasing, Fiscal, Services and CRM screens to the current
single-file shell would make the file unmaintainable before the first of them shipped.

## Target product information architecture

The application shell should move from one client-side `view` state in
`web/src/app/app/page.tsx` to real, bookmarkable routes. The sidebar should group related
capabilities and enforce visibility from permissions.

```text
Overview
Catalog
  Items and services
  Units
  Price lists
CRM
  Pipeline
  Accounts and contacts
  Activities
Sales
  Quotes
  Sales orders
  Customers
  Returns
Purchasing
  Requisitions
  Approvals
  Purchase orders
  Goods receipts
  Suppliers
Inventory
  Balances
  Movements / Kardex
  Transfers and adjustments
  Stock counts
  Production
Services
  Service orders
  Contracts
Finance
  Overview
  Accounts receivable
  Accounts payable
  Bank accounts
  Transactions
  Reconciliation
  Transfers
  Cash flow
  DRE
Fiscal
  Outbound documents
  Inbound documents
  Tax settings
Reports
Developers
  API keys
  Webhooks
  Delivery logs
  API documentation
Administration
  Company / workspace
  People and access
  Classifications
  Import and export
  Audit
  Preferences
```

On narrow screens these groups become drill-down navigation. Moving Webhooks and API
keys into **Developers** is an information-architecture change only: API-key ownership
remains in `identity/` and webhook delivery remains in `webhooks/`.

## Architecture decisions required before feature work

These decisions should be recorded as ADRs before creating new service folders.

### 1. Shared party registry

Create a `parties/` bounded context for legal persons and individuals that can hold one
or more roles: customer, supplier, carrier, prospect or partner. It owns tax identifiers,
legal/trading names, contacts, addresses, payment details, tags and attachments.

`sales/`, `procurement/`, `financial/`, `fiscal/` and `crm/` keep local event-fed
projections. Existing customers migrate without changing their public identifiers. This
prevents five incompatible customer/supplier tables from emerging.

### 2. Financial boundaries

Do not expand the current roadmap item into one large financial service. Use three
explicit boundaries:

- `financial/`: accounts payable/receivable, installments, due dates, categories,
  allocations, approvals, settlement state and cash forecasts.
- `treasury/`: bank/cash accounts, opening balances, internal transfers, statement
  imports, bank transactions, reconciliation and bank-integration adapters.
- `ledger/`: chart of accounts, balanced journal entries, period locking, trial balance,
  DRE and balance reporting.

`financial/` and `treasury/` publish immutable business facts; `ledger/` consumes them.
The user-facing flow can be synchronous inside a single context, but cross-context
effects use the established outbox/inbox pattern.

### 3. Posted records are reversed, not edited away

Draft records may be edited or deleted. Once posted, settled, reconciled or issued, a
record becomes immutable and corrections create reversals/credit entries linked to the
original. Every state transition stores actor, instant, reason and correlation id in the
local hash-chained audit log.

### 4. Money, dates and fiscal precision

- Keep money as an integer count of minor units with an explicit currency, through the
  `Money` value object (ADR 0010). Finance does not introduce a second money
  representation, and no monetary path uses floating point.
- Amounts stay non-negative; direction is an explicit property of the entry, not a sign.
- Values that need more precision than a minor unit — unit prices, tax rates, interest and
  penalty rates — use scaled integers with a declared scale, as `Quantity` already does.
- Persist instants as `timestamptz` in UTC (ADR 0011) and business dates — issue,
  competence, due, value and posting dates — as date-only columns.
- Store workspace timezone, legal country, base currency and fiscal regime separately
  from a user's display locale.
- Define rounding per operation and snapshot it on posted documents.
- Start with one document currency and BRL base reporting; defer exchange-rate gain/loss
  and consolidated multi-currency accounting until a later release.

### 5. Stable machine contracts

API paths, JSON property names, enum values, event types, permission names and audit
action names remain English and are never localized. Only presentation text is
translated. Every new cross-service event is added to `@horizon/contracts`, compatibility
checked and exact-pinned by consumers.

### 6. Query and reporting model

Operational services keep ownership of writes. A later `reporting/` projection consumes
events and builds tenant-scoped read models for dashboards and exports; it never writes
back into operational databases. Until then, each report stays inside the context that
owns its source data.

### 7. Module names, roles and API-key scopes

Authorization is static and module-scoped (ADR 0023), and an API key can never hold a
scope beyond its issuer (ADR 0022). Every new bounded context therefore introduces a
module name that is simultaneously an RBAC scope, an API-key scope, a navigation
visibility key and an audit dimension. Decide the full module list once, before the first
new service exists, rather than discovering it per phase:

`parties`, `financial`, `treasury`, `ledger`, `procurement`, `fiscal`, `services`, `crm`
and `reporting`, alongside the existing `identity`, `catalog`, `inventory`, `sales` and
`webhooks`.

Module names are machine contracts: they are never localized and never renamed once a
role assignment, API key or audit entry references them. Approval authority — payable
approval, purchase-order thresholds, stock-adjustment override, period locking — is a role
inside the owning module, not a separate global permission system.

## Platform wiring for every new bounded context

Each project in this repository is independent (ADR 0001), and the boundary check, CI
matrix and git hooks all read `scripts/modules.json`. A new context is not created by
adding a folder; the following are part of its first pull request, before any domain
feature is called complete:

| Wiring | File | What changes |
|---|---|---|
| Project registration | `scripts/modules.json` | New `{ path, kind: "service", port }` entry; the CI matrix, boundary check and hooks read it |
| Local orchestration | `Makefile` (`SERVICES`) | The service joins install, typecheck, lint, test and compose targets |
| Container | `infra/docker-compose.apps.yml` | Service definition, database, environment and health check |
| Gateway route | `gateway/kong.yml` | Upstream plus a `/<module>` route with `strip_path`, kept valid for `deck file validate` in CI and re-rendered by `make kong-config` |
| Persistence | the service's Drizzle migrations | Tenant id on every business table, forced RLS and its cross-tenant test |
| Messaging | the service's outbox/inbox tables and consumers | ADR 0024, with an inbox key per consumer and event type |
| Contracts | `contracts/` | New event schemas, compatibility check, version bump and exact-pinned consumers (ADR 0029, 0030) |
| Observability | the service's OpenTelemetry bootstrap | Traces, domain metrics and structured logs joined by correlation id (ADR 0033) |
| Seeds and smoke | `infra/scripts/smoke.sh` and the service's seed script | The context appears in the runnable local environment |
| Documentation | `docs/events.md`, `docs/glossary.md`, `docs/adr/` | Generated event catalogue, new business terms and the decision record |
| Database creation | `infra/postgres/init/01-roles-and-databases.sh` | The module's database joins `MODULES`; an existing local cluster needs it created by hand, because init runs once |
| Role module | `contracts/src/roles.ts` and identity's `test/contracts.spec.ts` | The module and its roles are published, and identity's guard test acknowledges it |
| Frontend proxy | `web/src/lib/upstream-path.ts` | The module joins the proxy's allowlist; without it every screen gets a silent 404 |
| CI lists | `.github/workflows/{golden-path,isolation,release}.yml` | The workflows that enumerate modules by hand gain the new one |
| Demo | `scripts/demo.mjs` | The operator gains the module's role and the golden path migrates its database |

Ports are allocated in phase order so that the compose file, gateway and `modules.json`
never disagree:

| Context | Port | Introduced in |
|---|---|---|
| `parties` | 3006 | Phase B |
| `financial` | 3007 | Phase B (dimensions), Phase C (titles) |
| `treasury` | 3008 | Phase D |
| `ledger` | 3009 | Phase F |
| `procurement` | 3010 | Phase G |
| `fiscal` | 3011 | Phase J |
| `crm` | 3012 | Phase L |
| `reporting` | 3013 | Phase M |

**Rollout order for a new module name.** Identity and Catalog reject an access token whose
role assignments name a module their pinned `@horizon/contracts` does not know. Every
service must therefore upgrade to the contracts version that declares the module *before*
any user is granted a role in it — otherwise that user is locked out of the services that
lag. `parties` shipped with every service moved to `@horizon/contracts@0.4.0` in the same
change for exactly this reason.

**Every consumer pins the current contracts version.** CI publishes only the version in the
checkout, so a project left on an older pin passes locally — where the registry still holds
it — and fails in every CI job. `scripts/check-contract-pins.mjs` enforces this in the repo
workflow and in the pre-commit hook.

Services are added in phase order and never speculatively: a registered project that
contains no delivered capability still costs CI time, compose memory and review attention.
Phase K adds service orders and contracts inside `sales/` unless its aggregates prove to
need their own transactional boundary, in which case that split gets its own ADR.

## Decision records to open

The repository has 39 decision records, `0001` to `0039`. The decisions above are recorded
before the code that assumes them, each as its own record and each added to the
`docs/adr/README.md` index and the README count:

| # | Decision |
|---|---|
| 0040 | A shared party registry, with role-fed projections per consuming context |
| 0041 | Financial, treasury and ledger are three boundaries, not one finance service |
| 0042 | Posted records are reversed, never edited or deleted |
| 0043 | Precision beyond the minor unit: scaled rates, date-only business dates and rounding snapshots |
| 0044 | Localization stops at the presentation boundary; API, event, enum, permission and audit names stay English |
| 0045 | A routed frontend shell with a permission-driven navigation registry |
| 0046 | Reconciliation suggests and a human confirms; suggestions never post by themselves |
| 0047 | Reporting projections consume events and never write back to operational databases |

## Implementation phases

Each phase must include domain/application tests, PostgreSQL RLS isolation tests, HTTP
contract tests, audit assertions, permissions, observability, responsive UI and browser
coverage for its critical path.

### Phase A — frontend foundation, localization and Developers

**Deliverables**

- Refactor the single `/app` view into nested App Router pages with shared shell, loading,
  empty, error and permission-denied states.
- Add a navigation registry containing route, label key, Phosphor icon and required
  permission; render the grouped target navigation from it.
- Add `next-intl` with typed namespaced messages in `messages/pt-BR.json` and
  `messages/en.json`.
- Resolve locale in this order: signed-in user's preference, locale cookie, browser
  preference, then `pt-BR`. Store `preferredLocale` on the global user, not the workspace.
- Keep authenticated URLs language-neutral. The ERP is not SEO content, and switching
  locale should not invalidate the current resource URL. `/api/**` is never localized.
- Add a user-menu language switcher that changes the document `lang` and refreshes the
  translated shell without signing out or changing workspace.
- Replace all hard-coded UI copy, including dialogs, notices, validation, empty states,
  table labels and accessible names. Translate status/enum labels at the view boundary.
- Centralize `Intl.NumberFormat`, `Intl.DateTimeFormat`, relative time, currency and
  plural formatting. Keep tax IDs, SKUs, API tokens and user-entered data unmodified.
- Create `/app/developers/api-keys`, `/app/developers/webhooks` and
  `/app/developers/deliveries`; remove API keys from Settings and drop the top-level
  Webhooks navigation item.
- Add API-key scope explanations, one-time secret copy/download, rotation overlap,
  last-used data and revoke confirmation. Add webhook test delivery, signature example,
  event catalogue, filtering and replay visibility.
- Add CI checks that locale files have identical keys and fail on newly introduced raw UI
  strings. Run browser flows in both locales and at the existing 390 px baseline.

**Route map for the existing screens**

The refactor is behavior-preserving. Every current `view` value becomes a route, and the
state that `web/src/app/app/page.tsx` holds today moves into the feature that owns it:

| Current `view` | Target route | Moves from `app/page.tsx` into |
|---|---|---|
| `overview` | `/app` | `features/overview/` |
| `catalog` | `/app/catalog/items` | already in `features/catalog/` |
| `customers` | `/app/sales/customers` | already in `features/sales/` |
| `quotes` | `/app/sales/quotes` | already in `features/sales/` |
| `orders` | `/app/sales/orders` | `features/sales/orders-view.tsx`, new |
| `inventory` | `/app/inventory/balances` | already in `features/inventory/` |
| `webhooks` | `/app/developers/webhooks` and `/app/developers/deliveries` | `features/developers/`, new |
| `access` | `/app/administration/people` | already in `features/access/` |
| `settings` — API keys | `/app/developers/api-keys` | `features/developers/`, new |
| `settings` — workspace | `/app/administration/workspace` | already in `features/settings/` |

Alongside the routes, Phase A extracts the parts of the shell that every later phase
reuses: a typed fetch client over `tracedFetch` with consistent RFC 9457 error handling,
list state (pagination, filter, sort, empty and error states), the confirmation and
drawer patterns currently inlined as dialogs, and the currency, quantity and date
formatters. A phase that adds Finance or Purchasing screens should add domain code, not
re-invent a table or a settlement dialog.

**Exit criteria**

- Login, workspace selection and every existing ERP screen work completely in `pt-BR`
  and English.
- Locale survives logout/login and workspace switching and formats currency/date without
  changing stored values.
- Existing API key and webhook lifecycle tests pass through the new Developers routes.
- The browser golden path (`make test-phase10`) completes through the new routes and still
  produces one joined trace, with its selectors bound to roles and test ids rather than to
  English copy.

### Phase B — common registrations and company configuration

**Deliverables**

- Implement `parties/`: customers, suppliers, prospects, carriers, contacts, addresses,
  bank/payment details, tags, attachments, activation and LGPD erasure.
- Migrate existing encrypted customer data and publish party-role events for projections.
- Add workspace company profile: legal name, tax id, state/municipal registrations,
  addresses, timezone, base currency, fiscal regime and logo.
- Add shared business dimensions: financial categories, cost centres/departments,
  projects, payment methods, payment terms/installment templates, sellers and buyers.
- Add import preview/validation/result flows for CSV initially. Keep import jobs
  idempotent and downloadable as an error report.

**Exit criteria**

- One party can safely be both customer and supplier without duplicate tax-id records.
- Sales reads customers from its projection; new services can consume the same party id.
- Dimensions can be allocated by percentage and validation requires a 100% total.

### Phase C — financial subledger: payable and receivable

**Progress:** receivables delivered as [plan phase 17](plan.md#phase-17--accounts-receivable)
(backlog item 8), payables and approvals as
[plan phase 18](plan.md#phase-18--accounts-payable-and-approvals) (backlog item 9).
Forecasts arrived with [plan phase 24](plan.md#phase-24--forecasts-a-confirmed-order-is-money-expected-invoicing-makes-it-owed).
Recurrence, bulk actions, attachments, fees, credits and refunds remain.

**Deliverables**

- Implement `financial/` with payable and receivable titles, installments, issue,
  competence and due dates, party, document number, description, currency, category,
  department/project allocations and attachments.
- Support drafts, forecasts and posted titles; open, partially settled, settled, overdue,
  cancelled and reversed states.
- Support partial/full settlement, discount, interest, penalty, fees, credits, refunds and
  settlement reversal. Require idempotency keys for every money-moving command.
- Add recurrence templates, bulk actions, approval policy for payables and aging views.
- Build Finance overview, searchable AP/AR tables, create/edit drawer, detail timeline,
  settlement flow and overdue indicators.
- Publish versioned title and settlement events for Treasury, Ledger and Webhooks.

**Exit criteria**

- Outstanding balance always equals original amount plus additions minus reductions and
  settlements; invariants are property-tested.
- A posted or settled title cannot be silently changed or deleted.
- Aging, upcoming due dates and cash forecast reconcile exactly with title detail totals.

### Phase D — treasury: accounts, balances and transfers

**Progress:** delivered as [plan phase 19](plan.md#phase-19--treasury-accounts-balances-and-transfers)
(backlog item 10). Available balance and overdraft limits are deferred; the imported
statement balance arrives with Phase E.

**Deliverables**

- Implement `treasury/` bank, cash, card/clearing and virtual accounts with bank code,
  branch/account metadata, opening balance/date, currency and active state.
- Create an append-only account transaction journal with value date, posting date,
  amount, direction, source, counterparty, memo and reconciliation state.
- Implement transfers as one aggregate containing linked debit and credit legs. Commit both
  legs atomically; fees are explicit third entries. Cancelling creates inverse entries.
- Expose book balance, reconciled balance, imported-statement balance and available
  balance with clear timestamps. Never label an ERP book balance as the bank's live balance.
- Add bank-account dashboard, account statement, transaction details, transfer form and
  account balance timeline.

**Exit criteria**

- A transfer cannot leave only one leg, even under retry or process failure.
- Sum of the account journal from opening balance equals the displayed book balance.
- Backdated entries recalculate projections deterministically and preserve audit history.

### Phase E — bank statements and reconciliation

**Progress:** delivered as [plan phase 20](plan.md#phase-20--bank-statements-and-reconciliation)
(backlog item 11). The bank-feed adapter port is declared without a provider; automatic
confirmation stays out until acceptance data justifies it.

**Deliverables**

- Add pluggable import adapters, starting with OFX and CSV; retain original file hash and
  raw-line fingerprint to prevent duplicate imports.
- Normalize statement lines without discarding bank-supplied identifiers or descriptions.
- Reconciliation supports 1:1, 1:N and N:1 matches, partial matches, ignored lines,
  unmatched ERP entries, undo and explicit adjustment creation.
- Build deterministic match suggestions using amount, date window, document id,
  counterparty and text similarity. Suggestions never auto-post in the first release.
- Add confidence/explanation to every suggestion and measure acceptance/correction rates.
- Define an encrypted adapter interface for future Open Finance/bank feeds without making
  a bank provider a core-domain dependency.
- Build an account/date reconciliation workspace with bank and ERP panes, keyboard-safe
  matching, filters, difference indicator and close-period action.

**Exit criteria**

- Reimporting the same statement creates zero duplicates.
- Reconciliation is reversible, fully audited and never changes the original statement.
- Opening balance + imported lines - unmatched difference agrees with the reconciliation
  summary for the selected period.

### Phase F — automatic financial integration and ledger

**Complete**, apart from the purchasing forecasts, which wait for `procurement/` in Phase G.

`ledger/` itself — the chart of accounts, the balanced journal, accounting
periods and the trial balance — is delivered as
[plan phase 22](plan.md#phase-22--the-general-ledger-chart-journal-periods-and-trial-balance),
and the posting rules and idempotent consumers that fill it from `financial/` and
`treasury/` facts as
[plan phase 23](plan.md#phase-23--automatic-postings-financial-and-treasury-facts-become-journal-transactions).
The sales forecasts are
[plan phase 24](plan.md#phase-24--forecasts-a-confirmed-order-is-money-expected-invoicing-makes-it-owed),
and the cash flow, the result of the period and the drill-down to source facts are
[plan phase 25](plan.md#phase-25--the-reports-the-books-exist-to-produce-and-the-way-back-to-the-facts).

**Deliverables**

- Implement `ledger/`: chart of accounts, posting rules, balanced entries, journal,
  period locking, trial balance and managerial DRE.
- Sales order approval creates receivable forecasts; invoicing replaces forecasts with
  effective receivables without duplication.
- Approved purchase/goods receipt creates payable forecasts/effective payables.
- Settlements and treasury movements post balanced journal facts through idempotent
  consumers. Transfers never affect profit/loss; fees do.
- Add cash flow (daily/weekly/monthly, expected versus realized), aging, DRE, trial balance
  and drill-down from reports to source facts.

**Exit criteria**

- Every journal transaction balances to zero per currency.
- Replaying every event into an empty Ledger database produces the same balances.
- Source totals, AP/AR totals, Treasury and report drill-downs can be reconciled by tests.

### Phase G — purchasing and supplier lifecycle

**Complete**, apart from purchase suggestions from min/max stock, which this plan defers
until inventory availability projections are trustworthy (Phase I).

Requisitions, supplier quotations and their comparison, approval thresholds and purchase
orders are delivered as
[plan phase 26](plan.md#phase-26--purchasing-a-need-what-suppliers-would-charge-and-what-the-company-committed-to);
receiving — partial and over-receipt, returns, the inventory movement and the payable they
produce — as
[plan phase 27](plan.md#phase-27--receiving-the-goods-on-the-shelf-and-the-money-owed-for-them-from-one-fact);
and the boards, the approval inbox, the comparison and the receipt conference as
[plan phase 28](plan.md#phase-28--the-purchasing-screens-what-was-asked-for-what-was-committed-what-arrived).

**Deliverables**

- Implement `procurement/`: purchase requisitions, supplier quotations, comparisons,
  approval thresholds, purchase orders, receipts, returns and cancellations.
- Snapshot supplier, price, tax, freight, payment and item data on approved orders.
- Receiving can be partial and links quantities to warehouse receipts and payable
  generation; over-receipt requires permission and reason.
- Add request/order Kanban, approval inbox, supplier comparison, receipt conference and
  purchase history.
- Add purchase suggestions from min/max stock and open demand only after inventory
  availability projections are trustworthy.

**Exit criteria**

- The demonstrated path is requisition → approval → purchase order → partial/full receipt
  → inventory movement → payable, all traceable by correlation id.
- Duplicate messages cannot duplicate stock or payable titles.

### Phase H — complete sales, fulfilment and returns

**Complete**, apart from commissions and profitability, which this plan defers until cost
and settlement data are stable (Phase I).

The commercial document — quote versions, rejection and expiry, the discount allowance,
conversion into an order and the terms the order carries — is delivered as
[plan phase 29](plan.md#phase-29--the-commercial-document-an-offer-negotiated-and-the-order-it-becomes);
picking, packing, partial delivery and the customer return with its stock and financial
reversal as
[plan phase 30](plan.md#phase-30--getting-the-goods-there-picking-partial-delivery-and-what-comes-back);
and the boards, the negotiation history, the approval queue and the deliveries board as
[plan phase 31](plan.md#phase-31--the-sales-screens-the-offer-the-decision-and-the-van).

**Deliverables**

- Add quote revision/versioning, rejection/expiry, conversion into order and approval.
- Add order amendments before confirmation, cancellation, payment schedule, seller,
  freight/carrier, discounts, allocations, fulfilment and status timeline.
- Add picking/packing/shipping states, partial fulfilment and customer returns with stock
  and financial reversal events.
- Add commissions and profitability projections after cost and settlement data are stable.

**Exit criteria**

- Quote → order → reservation → fulfilment → receivable is a tested, idempotent flow.
- Partial delivery and partial return preserve quantities, stock and money invariants.

### Phase I — inventory maturity and production

**In progress.** Warehouse transfers, manual adjustments with a reason and an approval
allowance, and stock counts with their discrepancy posting are delivered as
[plan phase 32](plan.md#phase-32--stock-moved-on-purpose-a-transfer-a-write-off-and-a-count).
The Kardex, valuation, stock position, min/max alerts, the ABC curve and the cost-of-goods
report are delivered as
[plan phase 33](plan.md#phase-33--the-warehouses-own-books-the-kardex-what-it-is-worth-and-what-to-do-about-it),
which also makes the balance reproducible from the movements in value as well as in
quantity. The remaining deliverables are sliced after it: lots, serial numbers and expiry;
product families, variants, kits, BOM and production orders; and the screens that close the
phase.

**Deliverables**

- Add warehouse transfers, manual adjustments with reason/approval, stock counts and
  discrepancy posting.
- Add immutable movement/Kardex detail, valuation, stock position, min/max alerts, ABC
  curve and cost-of-goods reports.
- Add lots, serial numbers, expiry and traceability as opt-in tracking policies per item.
- Add product families, variants, kits and BOM. Then implement production orders,
  material issue, finished-goods receipt, scrap and third-party production.

**Exit criteria**

- Balance is reproducible solely from immutable movements.
- No command can produce negative available stock unless the workspace policy explicitly
  permits it and the override is audited.
- A production order conserves quantities/cost across material issue and finished receipt.

### Phase J — fiscal documents

**Deliverables**

- Implement the already-declared `fiscal/` temporal rule engine and explanation output.
- Add fiscal profiles/scenarios, CFOP, NCM/CEST, CST/CSOSN and IBS/CBS classifications.
- Add NF-e/NFC-e/NFS-e state machines, numbering, issue, authorization, rejection,
  cancellation, correction and PDF/XML storage.
- Add inbound XML import, supplier/item association and links to purchase receipts and
  payables. Add remittance, return and complementary documents.
- Keep SEFAZ and municipality integrations behind ports with deterministic mocks first;
  certify providers/municipalities incrementally and state unsupported coverage in-product.

**Exit criteria**

- Historical recalculation uses the rule version effective on the document date.
- A rejected/cancelled fiscal document cannot create duplicate stock or finance effects.
- No UI or README claims legal coverage that an integration test cannot demonstrate.

### Phase K — services and recurring contracts

**Deliverables**

- Add service-specific fiscal metadata to catalogue entries.
- Implement service orders, proposals, execution stages, recurrence contracts, billing
  schedules, renewals, suspension, cancellation and batch billing.
- Generate receivables and NFS-e requests idempotently per contract period.

**Exit criteria**

- Re-running a billing period does not duplicate an invoice, fiscal request or receivable.
- Contract changes are effective-dated and do not rewrite already billed periods.

### Phase L — CRM

**Deliverables**

- Implement `crm/` with accounts backed by Party ids, multiple contacts, opportunities,
  configurable pipelines/stages, tasks, notes, activities, owners, sources and loss reasons.
- Add Kanban and table views, reminders, conversion forecast and conversion to quote.
- Publish conversion events for reporting without allowing CRM to mutate Sales directly.

**Exit criteria**

- Account/contact/opportunity → accepted quote preserves source attribution and owner.
- Pipeline metrics can be rebuilt from the activity/event history.

### Phase M — reporting, data operations and product hardening

**Deliverables**

- Add `reporting/` projections for cross-domain dashboards, scheduled exports and saved
  report filters; every row remains tenant-scoped with forced RLS.
- Implement CSV/XLSX export and asynchronous bulk import with preview, validation,
  idempotency, progress and downloadable failures.
- Add global search, command palette, saved filters, notifications, background-job centre
  and attachment lifecycle/virus-scanning adapter.
- Add invitations, MFA/passkeys, session/device management, segregation-of-duties checks,
  approval delegation and a searchable audit UI.
- Add backup/restore drills, retention policies, disaster-recovery objectives, financial
  consistency checks, service-level indicators and synthetic critical-path monitoring.

**Exit criteria**

- Cross-domain reports reconcile against their operational sources at a declared cutoff.
- Imports are resumable/idempotent and never partially hide failed rows.
- Security and recovery drills produce stored evidence, not only documentation.

## Priority and release slices

| Release slice | Phases | Usable outcome |
|---|---|---|
| P0 — foundation | A–B | Bilingual routed frontend, Developers area and shared ERP registrations |
| P1 — financial core | C–E | AP/AR, bank accounts, balances, transfers and statement reconciliation |
| P2 — integrated operations | F–H | Ledger/reports plus purchasing and a complete order-to-cash/procure-to-pay flow |
| P3 — vertical breadth | I–L | Advanced inventory/production, fiscal, services/contracts and CRM |
| P4 — production readiness | M | Cross-domain reporting, data operations, security and recovery hardening |

P0 and P1 are the next implementation target. Within P1, Accounts Receivable should be
implemented before Accounts Payable only to connect the already-working sales path
earlier; both share the same title/installment/settlement kernel and ship in the same
release slice.

## Cross-cutting definition of done

A feature is not complete when only its form and CRUD endpoint exist. Every phase must
satisfy all applicable items below:

- CRUD plus domain transitions, not unrestricted generic updates.
- Tenant id on every business table, forced RLS and cross-tenant tests.
- Static module permissions and least-privilege navigation/action visibility.
- Idempotency on external and money/stock-moving writes.
- Audit entries and reversible correction flow for posted records.
- Outbox/inbox for every cross-service effect and compatibility-gated contracts.
- Pagination, filtering, sorting, empty/error/loading states and bulk-safe APIs.
- Accessible Base UI primitives, Inter typography, Phosphor icons and Radix Colors.
- Full `pt-BR` and English message coverage with locale-aware dates/numbers/currency.
- Unit, property/invariant, database, contract and browser tests proportional to risk.
- OpenTelemetry traces, domain metrics, structured logs and operational runbooks.
- Seed data and at least one executable end-to-end scenario demonstrating the capability.

## Explicitly deferred scope

The following should not block the operational ERP milestones:

- Direct initiation of real bank transfers; Horizon first records transfers and later adds
  provider-specific payment initiation behind separately approved adapters.
- Automatic reconciliation without human confirmation.
- Payroll, HR/timekeeping and point-of-sale hardware.
- Full IFRS/CPC certification, SPED generation and universal municipality/bank coverage.
- Multi-company consolidation and realized/unrealized exchange-rate accounting.
- Native mobile/offline applications and marketplace/e-commerce hubs.

Each deferred item requires its own discovery and compliance plan before implementation.

## Documentation upkeep

The repository's claims are part of its product. A phase is not done while the
documentation still describes the previous state:

- `docs/plan.md` gains the new phases; completed ones are marked as such, as the existing
  phases are.
- `docs/roadmap.md` keeps only what remains deferred. When a roadmap entry is implemented,
  it moves out of the roadmap rather than being left as a superseded placeholder.
- `docs/events.md` is regenerated from the schemas with every contracts change.
- `docs/glossary.md` gains each new business term — title, installment, settlement,
  reconciliation, journal entry, requisition, goods receipt — in universal language, not
  only the Brazilian fiscal ones already listed.
- `docs/architecture.md` gains the reasoning a reviewer would challenge: why finance is
  three contexts, why posted records are reversed, and what the party migration costs.
- `README.md` describes only what a reader can run. Each new module appears there when its
  capability is demonstrable, and the decision-record count is kept accurate.

## Risks that can invalidate this order

| Risk | Signal to watch | Response |
|---|---|---|
| The party migration breaks the working sales path | Customer identifiers change, or sales tests need rewriting rather than re-pointing | Keep the sales projection's public identifiers stable; migrate behind an anti-corruption layer and delay the cut-over rather than the plan |
| Finance is built as CRUD and later cannot reconcile | Balances need manual correction, or a settlement is edited in place | Treat the outstanding-balance invariant as the acceptance test of Phase C, before any screen |
| Ledger consumes events that were never designed to be replayed | Replay into an empty database produces different balances | Require the replay test in Phase F's definition of done, not as a later hardening task |
| Fiscal integrations dictate the domain model | Domain aggregates start carrying SEFAZ or municipality field names | Keep integrations behind ports with deterministic mocks; certify providers incrementally |
| Breadth outruns depth | Several phases are partially delivered and none is demonstrable end to end | Ship release slices, not phases: a slice that cannot complete its golden path is not released |
| The shell degrades again | Feature pages start re-implementing tables, dialogs and formatters | Review new screens against the Phase A shared layer; a third copy of a pattern is a defect |

## First implementation backlog

The first executable backlog, in order, is:

1. Record ADRs 0040 to 0047 and index them, so the first line of new code has a decision
   behind it.
2. Split `web/src/app/app/page.tsx` into route-aware feature pages and add the permission
   navigation registry without changing behavior.
3. Install and configure `next-intl`; create equal typed `pt-BR` and English catalogues;
   migrate the shell, authentication and existing screens.
4. Create Developers routes and move API Keys, Webhooks and Delivery Logs into them.
5. Add global user locale preference and workspace legal/timezone/base-currency settings.
6. Register `parties` in `scripts/modules.json`, the Makefile, compose and the gateway,
   then implement it and migrate the current Sales customer aggregate compatibly.
7. Implement shared financial categories, departments/projects and payment terms.
8. Scaffold `financial/`, publish contracts and deliver Accounts Receivable end to end.
9. Add Accounts Payable and approvals using the same financial kernel.
10. Scaffold `treasury/`; deliver bank accounts, opening balances, account journal and
    atomic internal transfers.
11. Add OFX/CSV statement import and reversible manual/suggested reconciliation.
12. Extend the golden path to order → receivable → settlement → bank reconciliation and
    require one joined trace plus reconciled numeric assertions in CI.

**Status:** items 1 to 12 are delivered as plan phases 14 to 21, Phase F as plan phases 22
to 25, Phase G as 26 to 28 and Phase H as 29 to 31. Phase I has begun with plan phase 32,
which gives the warehouse its own commands — transfers, adjustments and counts — and the
movement history the valuation and stock reports will be built from.

