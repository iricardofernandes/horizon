# Phase 68 — Segregation of duties, delegation and the audit screen

Status: **delivered on 2026-09-28** ([evidence](readiness-phase68-evidence.md)). This is the execution record for
[Phase 68 of the production readiness plan](production-readiness-implementation-plan.md#68--segregation-of-duties-delegation-and-the-audit-screen).
Decision: [ADR 0062](adr/0062-segregation-of-duties-is-a-declared-matrix.md), revised below.
Extends ADR 0025 (the audit chain) and ADR 0023 (static roles).

## Result

After this phase:
- **One table of conflicting duties.** `@horizon/contracts` publishes it, and an auditor
  reads the controls there. Each module refuses its own pairs with the same answer: `403`,
  code `segregation-of-duties`.
- **Two approvals that did not exist.** A manual ledger entry, and a treasury transfer,
  wait for a second person above a per-currency threshold, as payables already do.
- **Delegation.** An approver lends their approval to a colleague for a period, for example
  during a holiday.
  - The approval records both names.
  - The delegate never approves their own work, or work of the person who lent the
    approval.
  - Delegations are audited, end on their date and can be revoked.
- **Reading the audit log.** Every module with an audit log answers `GET /<module>/audit`:
  - paginated;
  - filtered by actor, action, record and period;
  - with the chain's verdict for the page.
- **The audit screen** (`/app/administration/audit`) searches every module at once and
  exports what it found as CSV. A tampered row shows as a broken chain.

## Starting point

- **Four eyes already exist in three modules,** each with its own wording and a `409`:
  - payables: whoever asked for approval cannot decide it;
  - requisitions and orders: whoever submitted or placed it cannot decide it;
  - stock adjustments and counts: whoever asked or closed it cannot decide it.
- **Where the rule has gaps:**
  - a payable drafted by one person and sent for approval by another can be approved by
    whoever drafted it;
  - the requester of a requisition can approve the order made from it;
  - a manual ledger entry and a treasury transfer post at once, with no second person.
- **Approvals stop when the approver is away.** Only a module admin (or Procurement's
  `approver`) can decide, and nobody can stand in.
- **Audit logs.** Twelve modules keep a hash-chained, append-only log (ADR 0025):
  - nine share one layout: Sales, Financial, Treasury, Ledger, Procurement, Inventory,
    CRM, Reporting and Files;
  - Identity and Catalog hash a richer payload, and Identity encrypts personal diffs;
  - Fiscal hashes a digest of each detail.

  Only Identity and Catalog can verify their chain, and nobody can read a log except in
  the database. Parties and Webhooks keep no audit log.

## Decisions frozen by this plan

1. **The matrix** (`contracts/src/http/controls.ts`, contracts 0.50.0). Eight pairs of
   `<module>:<subject>:<action>` permissions. The same person may never hold both sides for
   the same record.

   | Pair | First duty | Second duty |
   |---|---|---|
   | `financial.payable` | `financial:payable:create`: drafted it or sent it for approval | `financial:payable:approve` |
   | `procurement.requisition` | `procurement:requisition:create`: requested or submitted it | `procurement:requisition:approve` |
   | `procurement.order` | `procurement:order:create`: placed it | `procurement:order:approve` |
   | `procurement.requisition-order` | `procurement:requisition:create`, for the order's requisition | `procurement:order:approve` |
   | `inventory.adjustment` | `inventory:adjustment:create` | `inventory:adjustment:approve` |
   | `inventory.count` | `inventory:count:close` | `inventory:count:approve` |
   | `ledger.entry` | `ledger:entry:create` (a manual entry) | `ledger:entry:approve` |
   | `treasury.transfer` | `treasury:transfer:create` | `treasury:transfer:approve` |

   - "Approve" covers deciding either way, so refusing is also barred.
   - The matrix is documentation and a test oracle, never a service. Each module's unit
     test asserts that its enforced pairs are exactly its rows.
2. **The refusal.**
   - The domain raises a `SegregationOfDutiesError` that names the pair.
   - HTTP answers `403` with `type: https://horizon.dev/problems/segregation-of-duties`,
     `code: segregation-of-duties` and `pair`.
   - The earlier `409`s for the same cases become this answer. The wording of each module
     stays.
3. **New approvals, shaped like payables.**
   - **Ledger:**
     - `PUT /ledger/approval-policies/{currency}` sets a threshold, admin only;
     - a manual entry at or above it becomes a **manual entry proposal**
       (`manual_entries`), and `POST /ledger/transactions` answers `202` with
       `{ manualEntryId, status: 'pending-approval' }`;
     - approving posts the transaction, and the month must still be open;
     - rejecting keeps the proposal as rejected.
   - **Treasury:**
     - `PUT /treasury/approval-policies/{currency}` sets a threshold, admin only;
     - a transfer at or above it is saved as `pending`, with no legs and no event;
     - approving writes the legs and publishes `treasury.transfer.posted`, dated at
       approval;
     - rejecting makes it `rejected`;
     - a pending transfer cannot be cancelled: it is rejected instead.
   - **With no policy, nothing changes:** entries and transfers post at once, as today.
   - Deciding needs a new `approve` action, held by `admin`.
4. **Financial records who drafted a payable** (`titles.created_by`). Older titles have
   none, and their check falls back to who asked for approval.
5. **Delegation, kept in each module** (`approval_delegations`, one table per module).
   - **Granting.** `POST /<module>/delegations` with `{ permission, delegateId, startsAt,
     endsAt, reason? }`.
     - The caller must hold the permission through their own role.
     - `permission` is one of the module's approve permissions in the matrix.
     - The delegate is someone else.
     - The period ends after it starts and after now, and lasts at most 90 days.
   - **Listing.** `GET /<module>/delegations`: approvers see every delegation, others the
     ones that name them.
   - **Revoking.** `POST /<module>/delegations/{id}/revoke`, by the delegator or anyone
     holding the permission through a role.
   - **Using it.**
     - Approve and reject routes now admit any role of the module. The use case decides:
       the person's own role, or else an active delegation (`starts_at <= now < ends_at`,
       not revoked) for that permission.
     - Without either, the answer is `403`.
     - A delegation cannot be passed on: granting needs the role itself, never a
       delegation.
   - **The check covers both names.** A decision through a delegation is refused when
     either the delegate or the delegator holds the conflicting duty on that record.
   - **Both names are kept.**
     - The approval stores the delegate and the delegator (`…decided_for`).
     - The audit row's actor is the delegate, and its details name `onBehalfOf` and
       `delegationId`.
     - Events are unchanged.
   - **Every change is audited:** delegation granted, revoked, and used.
   - **Revision of ADR 0062.** The ADR asked that the delegate already hold the approver
     role. A delegate who already held it would not need a delegation. Instead, the
     delegate holds a role in the module, which their own token proves each time they use
     it, and the delegation lends only the approval.
6. **The audit read contract** (contracts 0.50.0).
   - **The query:** `actor`, `action`, `subjectType`, `subjectId`, `from`, `to` (an
     instant range on `occurredAt`), `cursor` and `limit` (1–200).
   - **Each entry:** `sequence`, `occurredAt`, `actor`, `action`, `subjectType`,
     `subjectId`, `requestId`, `traceId`, `details` and `hash`.
     - Identity's encrypted diffs come back as `details: null`, with `sealed: true`.
     - Fiscal has only a digest, `details: { digest }`.
   - **The answer:** `{ data, page: { nextCursor?, hasMore }, chain }`, newest first. The
     cursor is the last sequence.
   - **`chain` judges the page:** `{ status: 'intact' | 'broken', checked, broken: [sequence…] }`.
     For every row on the page:
     1. its hash is recomputed from its own fields;
     2. its `previous_hash` must equal its predecessor's hash, or the genesis hash for
        sequence 1;
     3. its successor's `previous_hash` must equal its hash.

     A changed row, a deleted row, and a row re-hashed to cover a change all show. Two
     extra reads per page find the neighbours.
   - **Who may read it:** the module's `admin`. In Identity, `admin` and `owner`, through
     the existing `read Audit` permission.
7. **The audit screen reads the modules, never a copy** (ADR 0062). The web server
   (`/api/audit`) does the reading.
   - It asks every module whose admin the person is, with their token, 1.5 s each.
   - It merges the pages by `occurredAt`.
   - It shows each module's chain verdict, and names any module that did not answer.
   - `/api/audit/export` writes the same search as CSV, up to 50,000 rows, with the
     Phase 63 CSV writer, and states each module's verdict in the header.
   - Actors show by name when the person can read Identity's users. Otherwise they show
     by id.

## Work

### A — Contracts 0.50.0
1. `http/controls.ts`:
   - the matrix and the delegable permissions;
   - the refusal code and type;
   - the delegation schemas;
   - the audit query, entry and page schemas.
2. Tests. Then publish to Verdaccio and repin every service.

### B — The five modules with approvals
Financial, Procurement, Inventory, Ledger and Treasury each get:
1. **Migration:**
   - `approval_delegations`;
   - the `…decided_for` columns;
   - Ledger: `approval_policies` and `manual_entries`;
   - Treasury: `approval_policies`, and the new transfer states and columns;
   - Financial: `created_by`.
2. **Domain:**
   - `SegregationOfDutiesError`;
   - the delegation;
   - each decision taking the delegator into account.
3. **Application:**
   - granting, listing and revoking delegations;
   - resolving an actor's authority;
   - the new approval flows.
4. **HTTP:**
   - the delegation routes;
   - the approve and reject routes open to any module role;
   - the `403` refusal body.
5. **E2E, per pair:**
   - the pair is refused;
   - a valid delegation lets someone else decide;
   - a delegate cannot decide their own work, or work of the person who lent the approval;
   - an ended or revoked delegation no longer works.

### C — The audit read endpoint in twelve modules
1. `GET /<module>/audit`, with the page's chain check, in each module's own style.
2. **E2E in each:** a filtered page reads intact. A row changed as the database owner,
   with the trigger bypassed, reads as broken.

### D — Web
1. `/app/administration/audit`:
   - filters, merged results, and each module's verdict;
   - export;
   - a navigation entry for module admins;
   - pt-BR and English.
2. `/api/audit` and `/api/audit/export`, with the pure merge and paging in
   `src/lib/audit.ts`, with tests.

### E — Evidence
1. `scripts/phase68-drill.mjs`, through Kong, on a treasury transfer over the threshold. It
   stores its results in `docs/drills/`:
   - the pair refused with the shared code;
   - the same approval allowed through a delegation;
   - a revoked delegation refused;
   - a tampered row reported as broken by `/treasury/audit`.
2. **A browser run:** the audit screen shows that tampered row's module as broken, and
   exports the search.

## Exit evidence

- Every pair in the matrix is refused in an e2e test of its module, and allowed through a
  valid delegation to someone else.
- A tampered audit row shows as a broken chain on the screen.

## Left for Phase 70

These are screens. Phase 70 already lists the settings screens.
- Granting and revoking delegations in the web.
- The ledger and treasury approval queues, and their policies.

Until then, both are available through the API.

## Revisions made while implementing

- **The drill runs on Treasury, not Financial.** A payable needs a supplier from Parties
  and a category first; a transfer needs only two accounts, so the drill proves the same
  controls through Kong with nothing else running. Every pair, Financial's included, is
  proven by the e2e tests of its module.
- **A delegate lent the same approval by several people** decides for the first of them the
  record accepts, rather than for the first found and then refused.
- **Files keeps no roles** (ADR 0060), so its audit log is read by Identity owners and
  admins, as the screen expects.
- **A page's verdict judges its rows.** A row changed without re-hashing reads as broken on
  any page that holds it; one re-hashed to hide the change breaks its successor's link, and
  Fiscal's newest row must also be the tenant's recorded head.
- **Transfers keep their database guard.** The deferred check that a transfer has its two
  legs now accepts none while it waits, and asks for them again when it is approved.
- **The treasury transfer dialog says when a transfer waits** for a second person, rather
  than "transferred".
