# Phase 53 — Service screens, golden path and release evidence

Status: **delivered on 2026-09-27** ([evidence](services-phase53-evidence.md)). This is the execution record for
[Phase 53 of the services plan](services-implementation-plan.md#53--service-screens-golden-path-and-release-evidence).
It closes Phase K.

## Result

After this phase:
- a person runs services from the screens, in pt-BR and en:
  - **service orders:**
    - a board by stage;
    - a detail with lines, delivered quantities and deliveries;
    - opening an order, starting it, delivering, accepting, cancelling the order and
      cancelling a delivery;
  - **contracts:**
    - a list with the status today;
    - a detail with the terms, revisions, schedule and billed periods;
    - drafting, activating, amending, suspending, resuming, renewing, cancelling, billing
      one period and crediting it;
  - **billing runs:** a month's preview, the commit, each contract's outcome, recent runs,
    and the periods still waiting for a receivable or an NFS-e;
  - **the customer's services and contracts**, from the customer list;
- every delivery and billed period shows its **effects**:
  - the receivable and the NFS-e, with their status;
  - links to the Financial and Fiscal screens, which open the title or the document;
- a **golden path** on the local stack proves both flows end to end:
  - proposal → service order → delivery → receivable and NFS-e;
  - contract → two billed months → amendment → batch re-run with no duplicate → credit;
- a **browser workflow** walks the screens in pt-BR and en;
- a **restore check** proves contract and billing data survive a dump and restore intact,
  with their guards;
- the runbook, a threat model, the glossary and an API reference are complete, and Phase K
  is closed in the plans.

## Starting point

- **Sales APIs** exist for every step (Phases 50–52), but no screen uses them. The quote
  dialog only converts a proposal into a service order.
- **Effects:**
  - Sales follows the receivable and NFS-e of each billed period;
  - it knows nothing about the effects of a service delivery;
  - Fiscal's intake list can be filtered by document type and month.
- **Deep links:** the Financial and Fiscal screens open a title or a document only from
  their own lists, and read no URL parameter.
- **Existing checks to reuse:**
  - browser: the goods golden path (`npm run test:browser`) and the Fiscal workflow;
  - restore: the Phase 48 restore drill (Fiscal artifacts).

## Decisions

1. **Screens live in `web/src/features/services/`.** They follow the Sales screens:
   - a board, or a table, with a detail dialog;
   - buttons shown by role (visibility only; Sales refuses what a role may not do);
   - labels translated at the view (ADR 0044).

   Three new navigation entries under Sales: service orders, contracts and billing.
2. **Deliveries get their effects the way billed periods do** (ADR 0048):
   - Sales follows `financial.receivable.posted` (origin `sales-service-delivery`),
     `financial.receivable.reversed` and the NFS-e outcome (`service-delivery`) into two
     new tables;
   - they are not columns of the delivery, because a recorded delivery is never rewritten
     once cancelled;
   - the service order read returns them per delivery.

   The screens never read Financial or Fiscal to show a status.
3. **Links carry the id.**
   - The receivables screen reads `?open=<titleId>` and `?search=<text>`.
   - The Fiscal documents screen reads `?open=<documentId>`.
   - A draft receivable has no posted title yet: its link searches for the reference
     (`SV-…` or `CT-…`) in the receivables list.
4. **The billing screen keeps the same key for a month's commit until it succeeds.** A
   click that times out, repeated, resumes the same run instead of starting another.
5. **The golden path is one script over the API** (`scripts/phase53-golden-path.mjs`),
   like Phase 48's. The browser workflow (`web/scripts/services-workflow.e2e.mjs`) drives
   the screens.
6. **The restore check covers Sales only** (`scripts/phase53-restore-check.sh`).
   - It dumps `horizon_sales` and restores it into a new PostgreSQL.
   - It compares per-table digests of the contract, billing and service-order tables for
     the tenant, live against restored.
   - It proves the guards still refuse a rewrite, and that another tenant sees nothing.

   Financial and Fiscal already have their own restore evidence.

## Work

### A — Sales
1. **Migration `0015_service_delivery_effects.sql`:**
   - `service_delivery_effects` (receivable) and `service_delivery_line_nfse` (NFS-e per
     line);
   - RLS and grants.
2. **Consumers:**
   - the posted receivable for origin `sales-service-delivery`;
   - the reversal, matched against deliveries too;
   - the NFS-e outcome for `service-delivery`.
3. `GET /sales/service-orders/{id}` returns `effects` per delivery.
4. Unit and e2e tests of the projection, including RLS.

### B — Web
1. **Service orders:**
   - `/app/sales/service-orders`: a board of scheduled, in progress, completed and accepted
     orders;
   - a new-order dialog;
   - the detail dialog: lines with delivered and remaining quantities, deliveries with
     their effects, and the actions of the stage.
2. **Contracts:**
   - `/app/sales/contracts`: a table with the status today, recurrence and next period;
   - a new-contract dialog;
   - the detail dialog with tabs:
     - **Summary:** the terms and the decisions;
     - **Revisions:** the list and the amendment and renewal forms;
     - **Schedule:** the periods, billed or not, and why;
     - **Billed periods:** the effects of each, the credit, and billing one period.
3. **Billing:** `/app/sales/billing` has:
   - a competence month;
   - the preview with totals and each contract's reason;
   - the commit, with one key per month;
   - the run's outcome;
   - recent runs, and the periods waiting for a receivable or an NFS-e.
4. **Customers:** a "Services" action per customer lists their service orders and
   contracts.
5. **Links:** receivables read `open` and `search`; Fiscal documents read `open`.
6. **Supporting pieces:**
   - navigation;
   - pt-BR and en messages;
   - status labels;
   - pure helpers with unit tests: remaining quantities, the contract's next period, run
     totals, effect links.

### C — Evidence
1. **`scripts/phase53-golden-path.mjs`**, both flows on the local stack.
2. **`web/scripts/services-workflow.e2e.mjs`**, in pt-BR and en:
   - a service order opened, started, delivered and accepted, with its receivable and
     NFS-e shown and the Fiscal link opening the document;
   - a contract drafted, activated and billed from the billing screen;
   - the billed period's NFS-e shown;
   - a credit from the screen;
   - the customer's services.
3. `scripts/phase53-restore-check.sh`.
4. Re-run the duplicate, crash and cross-tenant suites: the Sales, Financial and Fiscal
   e2e.
5. Run `make check`, `make ci-local`, the goods golden path in the browser, and the
   isolation jobs.

### D — Documentation and closing
1. Complete `docs/services-billing-runbook.md`: the screens, restore, and everyday
   operation.
2. Add `docs/services-threat-model.md`.
3. Add `docs/services-api.md`, a reference of the service, contract and billing routes
   with examples.
4. Update the glossary.
5. Close Phase K:
   - the ADR 0056 status;
   - `docs/services-implementation-plan.md`;
   - `docs/plan.md`;
   - the expansion plan, with its two exit criteria and where they are proven.

## Exit evidence

| Criterion | Evidence planned |
|---|---|
| `make check` and the local CI pass | Their runs |
| The golden path and the browser workflow pass in pt-BR and en | `phase53-golden-path.mjs`; `services-workflow.e2e.mjs` in both languages; the goods browser golden path still green |
| Duplicate-run, crash and cross-tenant suites pass | Sales, Financial and Fiscal e2e (re-run, resume, replay, RLS) |
| No duplicate invoice, fiscal request or receivable | Golden path: re-run, same key and replayed events; one title and one NFS-e per delivery and period |
| Effective-dated changes never rewrite billed periods | Golden path: an amendment after two billed months leaves them as billed; a change at a billed period is refused |

## Out of scope

- A scheduler for billing runs, partial credits and substitution (Phase 52 limits).
- Dunning, CRM and reporting (Phases L and M).

## Changes made during implementation

- **Withdrawn receivables.** Sales hears of a receivable only once it is posted. A draft of
  a cancelled delivery or a credited period is shown as "withdrawn", not as a draft,
  because Financial withdraws it.
- **An authorization spec.** The threat model had no test of the Sales roles, so the
  guard now has one over the service routes' own metadata.
- **The Fiscal browser workflow** filters NF-e 55 in its English step too. The newest
  documents of the validation workspace are NFS-e now, so an unfiltered first page held no
  NF-e.
- **The restore check** leaves the cluster's monitoring extension out of the restore list,
  and creates the `horizon_debug` and `horizon_explain` roles the dump grants to.
