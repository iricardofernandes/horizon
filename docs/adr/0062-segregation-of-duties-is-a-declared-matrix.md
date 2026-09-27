# 62. Segregation of duties is a declared matrix, enforced by each module, with delegation

- Status: accepted; Phase 68 implements it.
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
     already hold the approver role in the module.
   - An approval by a delegate records both names.
   - A delegate can never approve their own work, and a delegation cannot be delegated.
   - Delegations are audited, end on their date and can be revoked.
4. **The audit screen.**
   - Each module gains an audit read endpoint: paginated, filtered by actor, action,
     record and period, with the chain-verification status of each page.
   - The screen searches them all at once.
   - There is no central copy of the audit log.

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
