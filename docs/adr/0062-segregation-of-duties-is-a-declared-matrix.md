# 62. Segregation of duties is a declared matrix, enforced by each module, with delegation

- Status: accepted; implemented in Phase 68 ([plan](../readiness-phase68-implementation-plan.md)), with the revision below.
- Date: 2026-09-27

## Context

Several modules already require a second person:
- payables above a per-currency policy (`financial/`);
- purchase requisitions and orders (`procurement/`);
- stock adjustments and count overrides (`inventory/`).

Each rule was written in its own phase, with its own wording and refusal. Some postings
have none: a manual journal entry, or a treasury transfer.

Nobody can read, in one place, which pairs of actions one person may never both do. And
approvals stop when the approver is away.

## Decision

1. **The matrix.** One table in `@horizon/contracts` lists the conflicting pairs, as
   `<module>:<subject>:<action>` permission identifiers, for example:
   - `financial:payable:create` / `financial:payable:approve`;
   - `procurement:requisition:create` / `procurement:order:approve`;
   - `inventory:adjustment:create` / `inventory:adjustment:override`;
   - `ledger:entry:post` / `ledger:entry:approve`;
   - `treasury:transfer:create` / `treasury:transfer:approve`.
2. **Enforcement.** Each module enforces its own pairs in its domain, from the actors it
   already records, with the shared refusal code `segregation-of-duties`. The matrix is
   documentation and a test oracle, never a runtime service.
3. **Delegation.**
   - An approver may delegate a subject to someone for a date range. The delegate must
     hold a role in the module, which their own token proves each time they use it
     (revised in Phase 68: a delegate who already held the approver role would not need a
     delegation).
   - An approval by a delegate records both names.
   - A delegate can never approve their own work, and a delegation cannot be delegated.
   - Delegations are audited, end on their date and can be revoked.
4. **The audit screen.**
   - Each module gains an audit read endpoint: paginated, filtered by actor, action,
     record and period, with the chain-verification status of each page.
   - The screen searches them all at once.
   - There is no central copy of the audit log.

## Revision (Phase 68)

- The delegate holds any role in the module; the delegation lends the approval alone.
- A delegator's role cannot be checked when the delegation is used: modules see only the
  caller's token. A delegation therefore lasts at most 90 days and can be revoked by any
  approver of the module.
- A decision through a delegation is refused when either the delegate or the delegator
  did the work. A delegate lent the same approval by several people decides for the first
  of them the record accepts.
- Files keeps no roles (ADR 0060), so its audit log is read by Identity owners and admins.

## Consequences

- An auditor reads one table to know the controls, and one e2e test per pair proves them.
- A new module adds its pairs to the matrix in the phase that adds the actions.
- The audit screen is only as fast as the slowest module. It shows partial results and
  says which module did not answer.

## Alternatives considered

- **A central policy engine** evaluating every command. It becomes a synchronous
  dependency of every write and a place where rules drift from the domain that knows
  them.
- **Tenant-configurable conflict rules.** Rejected for the same reason as configurable
  roles (ADR 0023): the reachable states can no longer be enumerated or tested.
