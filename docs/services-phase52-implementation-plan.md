# Phase 52 — Period billing and batch runs

Status: **delivered on 2026-09-26** ([evidence](services-phase52-evidence.md)). This is the execution record for
[Phase 52 of the services plan](services-implementation-plan.md#52--period-billing-and-batch-runs).

## Result

After this phase:
- a contract **period is billed** once:
  - billing freezes the revision, the lines, the amounts and the installments;
  - it publishes `sales.contract-period.billed`;
  - Financial raises one receivable and Fiscal one NFS-e per line, exactly as for a
    service delivery (Phase 50);
- a **billing run** for a competence month:
  - previews what it would bill, skip and refuse, and why;
  - commits under an idempotency key, bills contract by contract, shows its progress and
    each contract's outcome;
  - can be resumed after a crash;
  - never bills a period twice, whatever is re-run or replayed;
- a **credit** of a billed period (service not provided, or billed in error):
  - keeps the period, marked credited;
  - publishes `sales.contract-period.credited`;
  - Financial withdraws or reverses the receivable, and Fiscal cancels the NFS-e (101101)
    or shows why it cannot;
- Sales **follows the effects** of each billed period: whether its receivable was posted
  and whether each line's NFS-e was authorized. Metrics and alerts flag billed periods
  that have neither after a threshold, runs that refused contracts, and blocked Fiscal
  intakes.

## Starting point

- **Contracts (Phase 51):**
  - calendar periods named by the `YYYY-MM` of their first month, with a billing day;
  - immutable revisions, and a schedule read with the revision and amount of each period;
  - every change applies at a period start that is today or later. The rule for "not
    billed" was left for this phase.
  - Automatic renewal runs from `POST /sales/contracts/renewals`.
- **Service deliveries (Phase 50):**
  - Financial raises a draft effective receivable per delivery, keyed by the delivery,
    and withdraws or reverses it when the delivery is cancelled;
  - Fiscal records one intake per delivered line, keyed by the line's `entryId`. A worker
    turns it into an origin, a draft and (under `automatic`) an NFS-e;
  - a withdrawal cancels the NFS-e by 101101, withdraws a draft, or waits for a
    transmission in flight.
- **Fiscal publishes `fiscal.service-document.simulation-outcome`** with the origin's
  `sourceKey`, so an owner can follow the NFS-e of its own fact.
- **Financial publishes `financial.receivable.posted`** with the origin document, and
  `financial.receivable.reversed`.
- Sales has no background worker besides the outbox relay; the relay role reads the
  outbox of every tenant.

## Decisions

1. **The billed period is an entity of the contract aggregate.**
   - Its identity is `(contract, competence)`, unique in the database (ADR 0056,
     decision 3), with its own id (`billedPeriodId`). Each billed line has its own
     `entryId`.
   - Its facts never change. The only later writes are:
     - the credit, recorded once;
     - the projected effects (receivable, NFS-e), which are not facts of the period.
2. **When a period can be billed.**
   - The period is billable in the schedule: not suspended, not cancelled.
   - Its billing day has arrived (UTC day), so its competence month has begun.
   - It is not billed yet, and it bills something (a zero amount is skipped).
   - The installments come from the contract's payment terms, dated from the billing day.
   - The competence date is the first day of the period, the same for Financial and
     Fiscal.
3. **"Not billed" joins the change rule.** An amendment, suspension, resumption or
   cancellation at a period start is refused when a billed period starts on or after it.
   This only matters when the period starts today and was billed today.
4. **Identities downstream** (as in Phase 50):
   - **Financial:** origin `sales-contract-period`, keyed by `billedPeriodId`,
     reference `CT-…`.
   - **Fiscal:** one intake and one origin per billed line, with `sourceKey` =
     `sales` / `contract-period` / the line's `entryId` / competence.
   - A replay, or the same facts under a new event id, finds the same title, intake,
     origin and NFS-e.
5. **A billing run is a record in Sales**, with one item per candidate contract.
   - **Candidates:** active contracts with a period whose competence is the run's month,
     suspended and cancelled periods included, so they are listed as skipped.
   - **Outcomes:**

     | Outcome | Reasons |
     |---|---|
     | `billed` | — (with the billed period) |
     | `skipped` | `already-billed`, `suspended`, `cancelled`, `not-due-yet` (billing day not reached), `nothing-to-bill` |
     | `refused` | `customer-inactive`, `service-unavailable` (a line's Catalog item is inactive) |

   - **Preview** runs the same classification and writes nothing.
   - **Commit** (idempotency key) first runs the automatic renewals, then records the run
     and its items in one transaction.
   - **Processing:**
     - one transaction per contract, under the contract's row lock, classifying again
       from the state at that moment;
     - it answers the request once every item is decided;
     - the same key, or `POST …/resume`, continues the items still pending.

     A crash midway leaves pending items that the next call finishes, and the unique
     `(contract, competence)` makes a second bill impossible.
   - A run for a month that has not begun is refused. Past months can be run.
6. **Fiscal refusals stay in Fiscal.**
   - Sales holds no fiscal configuration, so it cannot know about a missing service
     profile or an unsupported municipality. Those appear as **blocked intakes** in
     Fiscal, with the reason.
   - `GET /fiscal/service-intakes` gains filters by `documentType` and `period`, so the
     intakes of one billing month can be listed.
   - Sales shows, per billed period, whether the NFS-e was authorized.
7. **A credit covers the whole billed period.**
   - Reason code `not-provided` or `billing-error`, plus a text.
   - **Financial:** as for a cancelled delivery:
     - a draft title is withdrawn;
     - a posted one with no settlement in force is reversed;
     - one with money received is flagged for a person.
   - **Fiscal:** each line's NFS-e is cancelled by 101101, with reason 2 (not provided)
     or 1 (issued in error). Outside the municipal window the intake shows the refusal,
     and a draft is withdrawn.
   - A credited period stays billed: it is not billed again.
   - **Substitution (105102) stays out, as in Phase 50.** A credit of the whole period
     leaves nothing to substitute with, and a corrected amount is a new charge, not a
     rewrite of the period.
8. **Sales follows the effects through owner events** (ADR 0048):
   - `financial.receivable.posted` with origin `sales-contract-period` records the title
     on the billed period, and `financial.receivable.reversed` records its reversal;
   - `fiscal.service-document.simulation-outcome` with `sourceKey.documentType =
     contract-period` records the NFS-e outcome on the billed line.

   A receivable counts once it is posted: a draft needs a person, like any receivable
   from a delivery.
9. **Metrics carry no tenant label** (ADR 0055):
   - counters of contract outcomes by outcome and reason, and a histogram of run
     duration;
   - gauges of billed periods older than the threshold (default 3 days) without a posted
     receivable, and without an authorized NFS-e on every line.

     They are read through the relay connection. It is granted only the columns needed to
     count: no tenant, customer or amount.
   - Fiscal adds a gauge of blocked service intakes (left open by Phase 50).
   - The alert rules live in `sales.rules.yml`, tested with promtool, with a runbook
     section per alert.
10. **Contracts `@horizon/contracts` 0.40.0:**
    - the two events;
    - the Financial origin;
    - the Fiscal intake read: `deliveryId` and `serviceOrderId` become nullable, beside
      the new `contractId` and `billedPeriodId`. This is breaking for a read with no
      consumer outside Fiscal, so it takes the minor bump.

## Work

### A — Contracts
1. `sales.contract-period.billed` v1:
   - `contractId`, `billedPeriodId`, `customerId`, `competence`, `revision`;
   - `startsOn`, `endsOn`, `issuedOn` (the billing day);
   - lines (`entryId`, `lineId`, `itemId`, `description`, `quantity`, `unitPrice`,
     `amount`), `value`, `installments`;
   - `runId` (nullable) and `billedBy`.
2. `sales.contract-period.credited` v1: `contractId`, `billedPeriodId`, `customerId`,
   `competence`, `entryIds`, `reasonCode`, `reason`, `creditedOn`.
3. Origin `sales-contract-period` in the Financial title events.
4. The Fiscal intake read as in decision 10.
5. Snapshot, `docs/events.md`, and every consumer pinned to 0.40.0.

### B — Sales
1. **Migration `0014_contract_billing.sql`:**
   - `contract_billed_periods` and `contract_billed_period_lines`: the facts are
     immutable (trigger), the credit is written once, and the projected columns are the
     only other updates;
   - `contract_billing_runs` and `contract_billing_run_items`;
   - RLS on all four, and grants;
   - the relay's column grants and read-only policy for the gauges.
2. **Domain:**
   - `contract-billing.ts`: pure classification of a period for a competence and a day,
     and the frozen billed period;
   - `ServiceContract.bill` and `ServiceContract.credit`, with their events;
   - "not billed" in `changeable`.
3. **Use cases:**
   - bill one period (idempotent);
   - credit one period (idempotent);
   - preview a run;
   - start a run (idempotent; renewals first);
   - process and resume a run;
   - project a posted or reversed receivable and an NFS-e outcome.
4. **HTTP:**
   - `POST /sales/contracts/{id}/periods/{competence}/bill`;
   - `POST /sales/contracts/{id}/periods/{competence}/credit`;
   - `GET /sales/contracts/{id}/billed-periods`; the schedule read shows the billed
     period of each competence;
   - `POST /sales/billing-runs/preview`;
   - `POST /sales/billing-runs` and `POST /sales/billing-runs/{id}/resume`;
   - `GET /sales/billing-runs` and `GET /sales/billing-runs/{id}`;
   - `GET /sales/contract-billing/overview`: recent runs and the billed periods still
     waiting for a receivable or an NFS-e.
5. **Metrics:** a billing-metrics port, its OpenTelemetry implementation, and the gauges
   refreshed through the relay connection.
6. Persistence in its own files, and in-memory fakes.

### C — Financial
1. Origin `sales-contract-period`: domain enum, contract and migration.
2. `sales.contract-period.billed` raises the effective receivable, `CT-…`, at most once
   per billed period.
3. `sales.contract-period.credited` withdraws, reverses or flags it, sharing the Phase 50
   logic.

### D — Fiscal
1. **Migration `0052_phase52_contract_periods.sql`:**
   - intake columns `contract_id`, `billed_period_id` and `withdrawal_code`;
   - the delivery columns become nullable, with a check per document type.
2. **Ingress:** binds both events, records the intakes, and requests their withdrawal on
   a credit.
3. **Worker:** the origin's source key and text follow the document type, and the
   cancellation takes the stored reason code.
4. **API:** the intake read and its filters.
5. A gauge of blocked service intakes and its alert.

### E — Evidence and documentation
1. **Unit tests:**
   - the classification: every skip and refusal;
   - billing freezes the revision and the amount;
   - the "not billed" change rule;
   - the credit;
   - the run use cases: preview, commit, resume, and a re-run that bills nothing.
2. **e2e with PostgreSQL:**
   - Sales:
     - a run, then a re-run and a new run for the same month;
     - a run stopped midway and resumed;
     - a credit;
     - the projections;
     - the immutability triggers;
     - RLS and cross-tenant access on the new tables;
   - Financial (its use cases are tested against PostgreSQL, as in Phase 50): one title
     per billed period on replay, and the credit;
   - Fiscal: intake to NFS-e once on replay, and the credit's cancellation.
3. `promtool` tests of the new alerts.
4. **Local smoke `scripts/phase52-smoke.mjs`:**
   - a contract from last month, and one whose service is deactivated;
   - a preview, then runs for both months, repeated with the same key and with a new key;
   - a replay of a billed fact under a new event id;
   - one title and one NFS-e per period;
   - an amendment refused for a billed period and accepted for a future one;
   - a credit that reverses the title and cancels the NFS-e, with the period kept.
5. `make ci-local`, the isolation jobs, the evidence record, the runbook sections, and
   the plan, README and glossary updates.

## Exit evidence

| Criterion | Evidence planned |
|---|---|
| Re-running a billing month, replaying its events and restarting a run midway yield one title and one NFS-e per contract period | Sales e2e (re-run, new run, resume after a stop); Financial and Fiscal e2e (replay); smoke (same key, new key, replay under a new event id) |
| Every refused contract is listed with its reason | Unit tests of the classification; the run items in e2e and in the smoke (deactivated service) |
| A credit reverses title and NFS-e and keeps the period | Financial and Fiscal e2e; smoke: title reversed, NFS-e cancelled by 101101, period listed as credited |

## Out of scope

- The screens for billing runs and billed periods (Phase 53).
- Substitution (105102) driven by Sales, and partial credits.
- A scheduler that starts runs by itself; a run is started through the API.
- Proration, indexation and dunning.

## Changes made during implementation

- **Fiscal intake counts are not in the support overview.** The overview is a published
  HTTP read, and 0.40.0 was already published when the gauges were added. The worker
  counts blocked and refused intakes for its gauges directly; the intake list, with its new
  filters, is the per-tenant read.
- **One way to record an intake line.** Fiscal records delivered lines and billed lines
  through the same function. Its digest is the same canonical digest over the same facts,
  so the Phase 50 intakes keep theirs.
- **Three defects the tests found before the smoke:**
  - a constraint named like a column check collided with Postgres's own name for it;
  - the Fiscal migration list did not include the new migration;
  - a date passed into a raw SQL fragment was not serialized.

