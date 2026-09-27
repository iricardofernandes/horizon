# Services implementation plan — Phase K

Status: **in progress** — Phases 49 and 50 delivered on 2026-09-26; phases 51–53 planned. This is the execution plan for Phase K of the
[ERP expansion plan](erp-expansion-plan.md#phase-k--services-and-recurring-contracts),
split into phases 49–53 of [plan.md](plan.md). Each numbered phase gets its own detailed
plan before implementation, one local commit and an evidence record, as in Phase J.

## Outcome and boundaries

Horizon sells goods end to end. Phase K lets it sell **services**:
- a service quoted and delivered once (a service order, with its execution stages);
- a service delivered repeatedly under a **contract** that bills every period (monthly,
  quarterly or yearly), with renewals, suspension, cancellation and batch billing.

Each billed service creates **exactly one** receivable in Financial and **exactly one**
NFS-e request in Fiscal, however often a period or a batch is re-run. Contract changes
are effective-dated and never rewrite a period already billed.

Out of scope:
- time tracking and technician scheduling beyond execution stages;
- usage-metered billing (pay per use);
- automatic price indexation from an external index (a reviewer enters the readjustment);
- dunning and payment collection (Financial already owns settlement);
- CRM (Phase L) and cross-domain reporting (Phase M).

## What already exists

| Need | Where it is today |
|---|---|
| Service items | Catalog items of kind `service` (`catalog-item.ts`) |
| Service fiscal metadata | Fiscal service profile: national tax code, NBS and ISS treatment, per Catalog item (Phase 47) |
| Customers, prices, quotes, payment terms | `sales/`: party-fed customer projection, price lists, versioned quotes and conversion to an order |
| Receivable from an owner fact | Financial creates a title from `sales.shipment.dispatched`, one per shipment, traced to its origin document |
| NFS-e from an owner fact | Fiscal service origin with an idempotent `sourceKey` (`module`, `documentType`, `id`, `period` `YYYY-MM`) and a competence date; national NFS-e in simulation (Phase 47) |
| Fiscal screens and support | Phase 48 worklist, support read and metrics |

Gaps:
- Sales treats every line as goods. A confirmed order reserves stock and is fulfilled by
  shipments, so a service line would wait for stock that never exists.
- There is no fact for "a service was delivered" or "a contract period was billed".
- Fiscal does not yet consume a Sales fact to create a service origin; Phase 47 origins
  are created through the API.

## Decisions to take first (Phase 49)

1. **Boundary.** Service orders and contracts live **inside `sales/`**, as the expansion
   plan says. They share the customer projection, price lists, quotes, sellers and
   payment terms, and a separate module would duplicate all of it.
   - The `services` module name stays reserved.
   - It is used only if a later aggregate needs its own transactional boundary, with its
     own ADR.
   - A sales order stays a goods order; services are delivered by a service order (see
     Phase 49).
2. **Ownership.**
   - Sales owns the service order, the contract and the billed period.
   - Financial owns the receivable.
   - Fiscal owns the NFS-e.
   - Nothing moves stock.
   - Each effect follows one owner event, never a call from Sales into another module
     (ADR 0048).
3. **Period identity.**
   - A contract period is identified by `(contract, YYYY-MM of its competence)`.
   - A billed period is immutable. A correction is a credit or a reversal linked to it,
     never an edit (ADR 0042).
   - The same identity is the Fiscal `sourceKey` and the Financial origin document, so a
     replayed event maps to the same origin, title and NFS-e.
4. **Fiscal automation.**
   - Fiscal turns a billed service fact into a service origin and an NFS-e **draft**.
   - Issuance follows a per-establishment policy: `review` (a person issues from the
     worklist) or `automatic` (issued as soon as it is ready).
   - Unsupported municipalities stay drafts with a visible refusal code.

## Phases

### 49 — Service lines and service decisions

[Detailed Phase 49 plan](services-phase49-implementation-plan.md).

**Work**
1. ADR 0056 records the decisions above. It adds one revision made while planning Phase
   49: **a sales order stays a goods order**.
   - A proposal (quote) carries goods and services.
   - From Phase 50, converting it creates a sales order for the goods and a service
     order for the services.
   - Putting service lines in the sales order would need a reservation-less version of
     `sales.order.confirmed`, and would duplicate the service order.
2. Sales projects the item kind from the Catalog, with a backfill for older items:
   - a service item is refused when placing a sales order, and when converting an
     accepted proposal with service lines (until Phase 50);
   - it never reaches Inventory.
3. Proposal and order screens show the kind of each line; the order form offers goods
   only.
4. A screen maintains the service fiscal profile (national tax code, NBS) through the
   Phase 47 Fiscal API.

**Exit evidence**
- A service never reaches Inventory.
- Goods orders and the goods golden path are unchanged.
- Old and new items know their kind.
- A person creates a service fiscal profile revision from the screen.

### 50 — Service orders and execution

[Detailed Phase 50 plan](services-phase50-implementation-plan.md) ·
[evidence](services-phase50-evidence.md).

**Work**
1. A service order comes from an accepted proposal, or is created directly. Converting a
   proposal creates a sales order for its goods lines and a service order for its service
   lines, from the same accepted version.
   - Stages: `scheduled`, `in_progress`, `completed`, `accepted` by the customer, or
     `cancelled` with a reason.
   - Each line shows the quantity delivered so far.
2. Completing (or accepting) a service order publishes `sales.service.delivered`.
   - It carries a delivery id, the service lines, the competence date, the customer and
     the payment terms.
   - It is published once per delivery, with a partial delivery allowed per line.
3. Financial consumes it:
   - one receivable per delivery, with origin `service-delivery`;
   - installments from the payment terms.
4. Fiscal consumes it:
   - a service origin with `sourceKey` (`sales`, `service-delivery`, delivery id,
     competence month);
   - an NFS-e draft, issued or held according to the policy.
5. Cancelling a delivered service links a reversal:
   - Financial reverses the title;
   - Fiscal cancels the NFS-e (event 101101) inside the municipal window, and outside it
     shows the refusal.

**Exit evidence**
- Replaying `sales.service.delivered` creates no second title, origin or NFS-e.
- A cancellation reverses both.
- Cross-tenant and RLS tests cover the new tables.

### 51 — Recurring contracts

**Work**
1. A contract aggregate:
   - customer and service lines (item, quantity, unit price);
   - recurrence: monthly, quarterly or yearly;
   - billing day, start date and optional end date;
   - payment terms, seller and notes.

   Lifecycle: `draft`, `active`, `suspended`, `cancelled`, `ended`.
2. **Effective-dated amendments** (price, quantity, lines, recurrence):
   - an amendment applies from a future period start;
   - billed periods keep the revision they were billed with;
   - each amendment keeps actor, reason and instant.
3. **Renewal**:
   - automatic or manual at the end date;
   - an optional readjustment percentage entered by a reviewer;
   - the renewal is itself an amendment.
4. **Suspension and cancellation** are effective-dated. Suspended periods are not
   billed; cancellation stops future periods and never touches billed ones.
5. **Period schedule:** a read that answers which periods a contract has, which are
   billable and with which revision, for any date range.

**Exit evidence**
- Amending a contract after a billed period leaves that period's revision and amount
  unchanged.
- A suspension removes exactly the periods it covers.
- Renewal continues the schedule with no gap and no overlap.

### 52 — Period billing and batch runs

**Work**
1. **Billing a period:**
   - freezes the contract revision and amounts;
   - publishes `sales.contract-period.billed`, with the period identity from decision 3,
     the competence date, due dates and service lines.

   Financial and Fiscal consume it exactly as in Phase 50, with origin `contract-period`.
2. **Batch run** for a competence month:
   - preview: what would be billed, skipped (suspended, ended, already billed) or refused
     (missing service profile, unsupported municipality);
   - commit with an idempotency key;
   - progress and per-contract outcome;
   - re-running the same month bills nothing twice.
3. **Credit for a billed period** (a service not provided, a billing error):
   - a linked credit that reverses the title;
   - cancels or substitutes the NFS-e (101101 or 105102), depending on the window;
   - never deletes the billed period.
4. Metrics and alerts for runs:
   - contracts billed, skipped and refused;
   - run duration;
   - billed periods without a receivable or an NFS-e after a threshold.

   They join the Phase 48 support reads.

**Exit evidence**
- Re-running a billing month, replaying its events and restarting a run midway yields
  one title and one NFS-e per contract period.
- Every refused contract is listed with its reason.
- A credit reverses title and NFS-e and keeps the period.

### 53 — Service screens, golden path and release evidence

**Work**
1. Screens in pt-BR and en:
   - service orders board and detail with stages;
   - contracts list and detail with amendments, schedule and billed periods;
   - billing run with preview, commit and results;
   - the customer's services and contracts.

   Status and effect links go to Financial and Fiscal.
2. Golden path on the local stack:
   - proposal → service order → delivery → receivable and NFS-e;
   - contract → two billed months → amendment → batch re-run with no duplicate → credit.
3. Browser workflow, restore check of contract and billing data, runbook for billing
   runs, threat model section, glossary and API docs.
4. Close Phase K in the plan and the expansion plan.

**Exit evidence**
- `make check` and the local CI pass.
- The golden path and the browser workflow pass in pt-BR and en.
- Duplicate-run, crash and cross-tenant suites pass.
- The expansion-plan exit criteria are both proven:
  - no duplicate invoice, fiscal request or receivable;
  - effective-dated changes never rewrite billed periods.

## Contracts added across the phase

Additive, versioned in `@horizon/contracts` and pinned by every consumer (ADR 0029, 0030):
- **Events:**
  - `sales.service.delivered`;
  - `sales.service.delivery-cancelled`;
  - `sales.contract.activated`, `sales.contract.amended`, `sales.contract.suspended`,
    `sales.contract.cancelled`;
  - `sales.contract-period.billed`;
  - `sales.contract-period.credited`.
- **HTTP schemas** for service orders, contracts, amendments, schedules, billing runs and
  their previews.
- **Financial title origins** `service-delivery` and `contract-period`, added to the
  origin enum without changing existing origins.

## Risks

- **Municipal rules.** NFS-e coverage stays whatever Phase 47 supports; contracts for
  unsupported municipalities bill in Financial and keep a refused fiscal draft. The
  screens must show this rather than hide it.
- **Competence and due dates.** The competence month (tax) and the due date (money)
  differ, and ISS and IBS/CBS rules follow the competence. Both are frozen when a period
  is billed.
- **Sales size.** `sales/` grows. If contracts or service orders need their own
  transactional boundary, the split is decided in its own ADR, not mid-phase.
