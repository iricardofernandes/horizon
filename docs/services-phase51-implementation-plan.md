# Phase 51 — Recurring contracts

Status: **delivered on 2026-09-26** ([evidence](services-phase51-evidence.md)). This is the execution record for
[Phase 51 of the services plan](services-implementation-plan.md#51--recurring-contracts).

## Result

After this phase, Sales holds **service contracts**:
- a customer, service lines (item, quantity, unit price), a recurrence (monthly, quarterly
  or yearly), a billing day, a start date, an optional end date, payment terms, a seller
  and notes;
- a lifecycle of `draft`, then `active`, with effective-dated suspension, cancellation and
  end;
- **amendments** to prices, quantities, lines and recurrence that apply from a period that
  has not started yet, as a new immutable **revision** with actor, reason and instant;
- **renewal**, manual or automatic, which is itself a revision. It extends the schedule
  with no gap and no overlap, and can carry a readjustment percentage entered by a
  reviewer;
- a **period schedule** read that answers, for any date range, which periods the contract
  has, whether each is billable, with which revision and for how much.

Nothing is billed yet. Phase 52 bills periods from this schedule.

## Decisions

1. **Calendar-aligned periods.**
   - A contract starts on the first day of a month.
   - A period is one, three or twelve months long, and is named by the `YYYY-MM` of its
     first month. That name is the competence of the future billed period (ADR 0056,
     decision 5).
   - The billing day (1 to 28) is the day, in the period's first month, on which Phase 52
     bills it; the due dates follow the payment terms from that day.
   - An end date is the last day of a period, so a contract never ends mid-period and
     nothing is prorated.
2. **Revisions, not edits.**
   - The contract as signed is revision 1. Every amendment or renewal adds a revision that
     applies from a period start, and the revision in force for a period is the latest
     one that starts on or before it.
   - Revisions and their lines are insert-only in the database.
3. **Nothing reaches back.**
   - An amendment, a suspension, a resumption or a cancellation takes effect at a period
     start that is today or later, so a period that has begun keeps its revision and
     amount.
   - Phase 52 adds "and not billed" to the same check.
   - A renewal starts the day after the current end, which may be in the past for a
     contract that already ended: those periods are new, so nothing is rewritten.
4. **A change of recurrence re-anchors the grid** from the amendment's period start. The
   end date must still fall on a period end of the new grid, or the amendment is refused.
5. **Renewal.**
   - A contract with an end date renews for its original term:
     - manually, by a person, with an optional readjustment in basis points applied to
       every unit price, half-up;
     - or automatically, with no readjustment, once its last period has begun.
   - Automatic renewal runs from `POST /sales/contracts/renewals`, which is idempotent per
     end date. Phase 52's billing run calls the same use case first.
6. **Status is read on a day**: `draft`, `active`, `suspended` (a suspension covers the
   day), `cancelled` (on or after the cancellation) or `ended` (after the end date).
7. **Events** (additive, `@horizon/contracts` 0.39.0):
   - `sales.contract.activated`;
   - `sales.contract.amended` (kind `amendment` or `renewal`);
   - `sales.contract.suspended` (published again with its resumption date);
   - `sales.contract.cancelled`.

   They carry identities, dates and revisions, not lines. No module consumes them yet;
   money and NFS-e follow the billed period (Phase 52).

## Work

### A — Contracts
The four events, their tests, the snapshot and the events catalogue. Every consumer is
pinned to 0.39.0.

### B — Sales
1. **Migration `0013_service_contracts.sql`:**
   - tables:
     - `service_contracts`;
     - `service_contract_revisions` and `service_contract_revision_lines` (insert-only);
     - `service_contract_suspensions`;
   - RLS and grants.
2. **Domain:**
   - `contract-schedule.ts`: a pure period grid, the revision in force, billability and
     amounts;
   - the `ServiceContract` aggregate: draft, activate, amend, suspend, resume, cancel,
     renew and read status on a day;
   - unit tests for the exit criteria.
3. **Use cases:**
   - create a draft, priced from the Catalog projection (services only);
   - activate, amend, suspend, resume, cancel;
   - renew one contract;
   - renew the due contracts.
4. **HTTP:**
   - `GET/POST /sales/contracts`, `GET /sales/contracts/{id}`;
   - `GET /sales/contracts/{id}/schedule?from=&to=`;
   - `POST /{id}/activate`, `/{id}/amendments`, `/{id}/suspensions`, `/{id}/resume`,
     `/{id}/cancel`, `/{id}/renewals`;
   - `POST /sales/contracts/renewals`.
5. Persistence in its own file, and an in-memory fake.

### C — Evidence and documentation
1. **Unit tests:**
   - the grid;
   - a recurrence change;
   - an amendment leaves earlier periods unchanged;
   - a suspension removes exactly its periods;
   - a renewal continues with no gap or overlap, with the readjustment;
   - refusals of anything that reaches back.
2. **Sales e2e with PostgreSQL:**
   - the lifecycle with events;
   - the insert-only revisions;
   - RLS and cross-tenant access;
   - an idempotent automatic renewal.
3. **Local smoke `scripts/phase51-smoke.mjs`:**
   - a monthly contract;
   - an amendment from next month;
   - a suspension and a resumption;
   - a renewal with readjustment;
   - the schedule read back.
4. `make ci-local` and the isolation jobs; the evidence record; the plans, READMEs and
   glossary.

## Exit evidence

| Criterion | Evidence planned |
|---|---|
| Amending after a period leaves that period's revision and amount unchanged | Domain tests and smoke: the schedule of earlier periods is identical before and after |
| A suspension removes exactly the periods it covers | Domain tests and smoke |
| Renewal continues the schedule with no gap and no overlap | Domain tests, e2e and smoke |

## Out of scope

- Billing periods, batch runs and credits (Phase 52).
- Contract screens (Phase 53).
- Proration of partial periods, and indexation from an external index.
