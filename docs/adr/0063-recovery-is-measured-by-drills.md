# 63. Recovery is measured by drills, and retention is declared per table class

- Status: accepted; Phase 69 implements backups, drills and retention. Phase 70 adds
  service levels.
- Date: 2026-09-27

## Context

Each late phase proved one module's restore: Fiscal in Phase 48, services in Phase 53 and
CRM in Phase 60. Nothing restores the whole system.

- **No recovery objective.** Nothing states how much data may be lost (RPO) or how long a
  restore may take (RTO).
- **Retention is mostly undecided.**
  - Inbox rows are never deleted, although a retention setting is declared.
  - Outbox rows are kept forever, and ADR 0058 now depends on that.
  - Exports and attachments will need expiry.

## Decision

1. **Objectives:** RPO 15 minutes and RTO 1 hour, for the whole stack in one region.
   - PostgreSQL uses WAL archiving and scheduled base backups.
   - Object storage is versioned.
   - The runbook states both objectives and how they are met.
2. **The drill** restores every module database and the object storage into a fresh
   stack, to a point in time, then runs:
   - the audit chain check of every module;
   - the reporting reconciliation checks (ADR 0058);
   - the financial consistency checks;
   - a synthetic golden path.

   It stores an evidence record with timings, digests and results, as a CI artifact and
   under `docs/drills/`. A drill that misses an objective fails.
3. **Retention by table class:**

   | Class | Examples | Rule |
   |---|---|---|
   | Posted and audit records | journal entries, titles, audit logs, the reporting journal | Never removed by retention |
   | Event history | outbox | Kept; it is the replay source (ADR 0058) |
   | Delivery bookkeeping | inbox, command receipts, denylist | Removed after a declared age longer than any redelivery or retry window |
   | Generated files | exports | Removed after a declared age |
   | Attachments | `files/` | Per record type (ADR 0060) |

   Every retention job logs what it removed, in counts per class and tenant.
4. **Consistency checks** run on a schedule and store their results:
   - receivables and payables against their ledger control accounts;
   - treasury balances against the cash accounts;
   - stock valuation against the inventory accounts.

## Consequences

- Recovery claims become test results, and a regression in restore time fails the build.
- Keeping outboxes forever grows each producer's database with its history. That is the
  cost of a rebuildable reporting store, and it is measured in the drill's evidence.
- A restore can lose at most the last 15 minutes. Producers restored behind `reporting/`
  surface as seal mismatches rather than silent gaps.

## Alternatives considered

- **Logical dumps only.** Simple and already used by the per-phase checks, but a nightly
  dump means an RPO of a day.
- **Managed database backups outside the repository.** Real deployments will use them. The
  drill still has to exist, because a backup that was never restored is a hope, not a
  control.
