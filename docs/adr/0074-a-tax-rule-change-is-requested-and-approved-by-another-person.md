# 74. A tax rule change is requested and approved by another person, with its diff and impact

- Status: accepted. Implemented in Phase 88 ([plan](../tax-phase88-implementation-plan.md)).
- Date: 2026-10-01

## Context

Since Phase 82, one person with the database URL could, through a CLI, adopt or withdraw a
catalogue package. Since Phase 41 a workspace's own rules have arrived through rollout CLIs.
Either way, a single person changed the taxes every later document of the workspace is
calculated with. Nobody saw beforehand what the change did to the rules, or to the documents
already locked. ADR 0062's matrix has no pair for it.

## Decision

1. **Every change to the rules a workspace calculates with is a request:**
   - adopt a catalogue package from a date, or withdraw one;
   - add a workspace rule (a full definition with its legal basis), or retire one.

   A Fiscal admin requests. Another person approves or rejects, with `fiscal:rules:approve`,
   which only the admin role holds, or through a delegation of it.
2. **Whoever requested never decides,** either way, in person or through a delegation lent
   by them.
   - The refusal is ADR 0062's `segregation-of-duties`, with the pair `fiscal.rules`.
   - The database refuses the same decision a second time, on any path.
   - Only the requester cancels a pending request.
3. **Approval applies the change in the same transaction,** after checking it still holds:
   - the package is still not adopted, or still adopted;
   - no tie with an active rule;
   - the rule is still active.

   A workspace rule becomes its own source package. Its bytes are the definition and the
   legal basis. The requester retains them and the approver reviews them, so Phase 41's
   review guard also sees two people.
4. **A request carries its diff and its impact,** computed when it is made and kept with their
   digests.
   - **The diff** compares the change with the rules in force, key by key: added, ended,
     changed with the fields that differ, or unchanged.
   - **The impact** recalculates the calculations the workspace locked in the last N months
     (3 by default, at most 12), never locking them.
     - The change is in force over the whole window.
     - It lists every document whose amounts would change, component by component, and every
       one that would no longer calculate or that the support matrix would no longer cover.
     - It reads at most 2,000 calculations, and says when it was cut.
5. **There is no other way to adopt.** The CLIs request and approve with two named actors,
   and the catalogue's direct adoption method is gone.
6. **Every request, decision and cancellation is audited,** with both names when a
   delegation was used.

## Consequences

- One person can no longer change a workspace's taxes alone. An absent approver is covered
  by a delegation, as in the other modules.
- The approver decides on what the change does, not only on what it is. A locked document
  never changes: the impact is information for the decision.
- A workspace rule that replaces another must differ in priority or window, because the
  store refuses an equal scope over an overlapping window even when the other is retired
  (Phase 41).

## Alternatives considered

- **Approve without an impact report,** and let the documents show the effect. Rejected: the
  approver would sign blind, which is what four eyes is meant to prevent.
- **Recalculate the impact when approving rather than when requesting.** Rejected: the
  approver must see the same report the requester saw, under the same digest. Approval
  checks that the change still applies instead.
- **Let the reviewer role approve.** Rejected by the workspace owner: the reviewer reviews
  imports and would come to change the taxes calculated.
