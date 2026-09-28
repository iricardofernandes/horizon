# Phase 68 — evidence: segregation of duties, delegation and the audit screen

Status: **delivered on 2026-09-28** (local runs between 14:30 and 18:30 UTC).
Plan: [readiness-phase68-implementation-plan.md](readiness-phase68-implementation-plan.md).
Decision: [ADR 0062](adr/0062-segregation-of-duties-is-a-declared-matrix.md), revised.
Drill record: [drills/2026-09-28-phase68-controls-drill.json](drills/2026-09-28-phase68-controls-drill.json).

## What was delivered

- **Contracts 0.50.0** (`http/controls.ts`), with every service repinned:
  - the matrix of eight pairs and the approvals each module lends;
  - the shared refusal: `403`, `code: segregation-of-duties`, and the pair;
  - the delegation schemas;
  - the audit query, entry, chain and page schemas.
- **Five modules enforce their pairs,** each with a unit test holding its rows equal to the
  matrix:
  - **Financial** records who drafted a payable (`created_by`). The drafter and the
    requester are both refused.
  - **Procurement** refuses the requester or submitter of a requisition, the placer of an
    order, and the requisition's requester on its order.
  - **Inventory** refuses the asker of an adjustment and whoever closed a count.
  - **Ledger:** a manual entry at or above `PUT /approval-policies` waits as a proposal
    (`202`). Approving it posts the transaction into a month that must still be open.
  - **Treasury:** a transfer at or above the threshold waits with no legs and no event.
    Approving it writes and announces them. The database's deferred leg check now knows a
    transfer that waits.
- **Delegation in each of the five** (`approval_delegations`):
  - `POST`, `GET` and `POST /delegations/{id}/revoke`;
  - at most 90 days, and never passed on;
  - the decision stores the delegate and the delegator (`…decided_for`), and the audit
    row names `onBehalfOf` and `delegationId`;
  - database checks repeat the four-eyes rules for the delegator.
- **`GET /audit` in twelve modules:**
  - Identity, Catalog, Sales, Financial, Treasury, Ledger, Procurement, Inventory, Fiscal,
    CRM, Reporting and Files;
  - each page is judged: every row recomputed, and linked to its neighbours (Fiscal also
    to its head);
  - Identity's encrypted diffs read as `sealed`, and Fiscal's details as their digest.
- **The web.**
  - `/app/administration/audit`, under Administration: filters, the merged entries, each
    module's chain verdict, the failing rows marked, and "load more".
  - `/api/audit` and `/api/audit/export`, the export with each module's verdict in its
    header.
  - Actors are shown by name for Identity administrators.
  - The treasury transfer dialog says when a transfer waits.
  - All of it is in pt-BR and English.

## Exit criteria

### Every pair refused, and allowed through a valid delegation

| Pair | E2E test | Refused | Allowed through a delegation |
|---|---|---|---|
| `financial.payable` | `financial/test/controls.e2e-spec.ts` | drafter and requester, even holding the approval; also through a delegation lent by either | stand-in lent by the controller; row keeps `approval_decided_for` |
| `procurement.requisition` | `procurement/test/procurement.e2e-spec.ts` | the buyer who requested and submitted | stand-in lent by the manager |
| `procurement.order` | same | the buyer who placed it | stand-in lent by the manager |
| `procurement.requisition-order` | same | the requester of the requisition, in person and through their own delegation | stand-in lent by the manager |
| `inventory.adjustment` | `inventory/test/stock-operations.e2e-spec.ts` | the asker, in person and through their delegation | stand-in lent by the manager |
| `inventory.count` | same | whoever closed the count | stand-in lent by the manager |
| `ledger.entry` | `ledger/test/ledger.e2e-spec.ts` | the writer, in person and through their delegation | stand-in lent by the controller, after the writer's was revoked |
| `treasury.transfer` | `treasury/test/treasury.e2e-spec.ts` | the requester; a pending transfer cannot be cancelled | stand-in lent by the treasurer; the legs appear only then |

Financial's tests also prove that:
- a delegation cannot be passed on;
- only the delegator or an approver revokes it;
- a revoked or ended delegation gives nothing.

### A tampered audit row shows as a broken chain on the screen

**Every module's e2e test tampers a row as the database owner,** with the trigger bypassed,
and reads the page as broken:

| Module | What was changed | Verdict |
|---|---|---|
| Financial | details of row 1 | broken at 1; after re-hashing it, a filtered page without it breaks at its successor, 2 |
| Procurement | actor of row 1 | broken at 1 |
| Inventory | occurred_at of row 2 | broken at 2 |
| Ledger | row deleted | broken |
| Treasury | details of the approval | broken |
| Sales | actor of row 3 | broken at 3 |
| CRM | actor of row 1 | broken at 1 |
| Reporting | actor of the reconciliation row | broken at it |
| Files | actor of row 2 | broken at 2 |
| Identity | action of row 1 (over HTTP) | broken, contains 1 |
| Catalog | action of row 3 | broken at 3, as the existing verifier says |
| Fiscal | actor of row 1 | broken at 1 |

**The drill,** `node scripts/phase68-drill.mjs`, ran through Kong with `"passed": true`:

| Check | Evidence |
|---|---|
| The pair is refused with the shared code | The transfer of 2,500.00 waited (`pending`). Its requester, given the admin role, got `403`, `segregation-of-duties`, `treasury.transfer` |
| Refused without the approval, allowed through a delegation | The stand-in (Treasury viewer) got `403` without a code, then `200` once the treasurer lent the approval. The transfer reads `posted`, decided by the stand-in for the treasurer |
| A revoked delegation no longer works | After revocation, the next transfer's approval got `403`, and the delegation lists as `revoked` |
| A tampered row reads as broken | `/treasury/audit` read 8 rows intact. After the approval row's details were changed, it read `broken: [6]`. An operator reading the log got `403` |

**Browser run (Chromium, pt-BR).**
1. A new workspace. Its owner held the Treasury, Financial and Ledger admin roles, and a
   clerk the Treasury operator role.
2. The clerk asked for a transfer of 2,500.00 over a threshold of 1,000.00, and the owner
   approved it.
3. Row 5 of the Treasury log was changed in the database.
4. **Administração → Auditoria** listed Identidade, Financeiro, Contabilidade and Arquivos
   as "ÍNTEGRA", and Tesouraria as **"QUEBRADA EM 5"**. The `transfer.approved` row was
   highlighted and marked "#5 QUEBRADA".
5. **Exportar CSV** downloaded 14 rows. Its header read `chain.treasury;broken at 5`, and
   `intact` for the others.
6. At 390 px the page did not overflow.

## Tests

- **Contracts:** 147 unit tests, among them the matrix, the refusal body, delegations and
  the audit page.
- **Unit tests:**

  | Financial | Procurement | Inventory | Ledger | Treasury |
  |---|---|---|---|---|
  | 83 | 49 | 177 | 45 | 34 |

  They cover the delegation's rules, `checkDuties`, and the matrix held equal to the
  module's rows.
- **E2E, over PostgreSQL:**

  | Financial | Procurement | Inventory | Ledger | Treasury |
  |---|---|---|---|---|
  | 48 | 27 | 65 | 38 | 24 |

  | Identity | Catalog | Sales | CRM | Reporting | Files | Fiscal inbound |
  |---|---|---|---|---|---|---|
  | 50 | 40 | 32 | 30 | 18 | 8 | 5 |
- **Fiscal:** 172 unit tests, among them the admin-only `/audit` route.
- **Web:** 112 unit tests, 9 of them new for the federated audit and its export. The copy
  check passes.
- **`make check`:** passed. So did `make test-phase10`, the golden path at 390 px, against
  the rebuilt stack.

## Findings along the way

- **A delegate may hold several delegations for one approval.** Taking the first one found
  refused decisions that another lender could have allowed. The use case now tries each
  lender.
- **Transfers had a database guard for their legs.** A pending transfer broke it at
  commit. It now expects no legs while a transfer waits, and both legs once it is approved.
- **A filtered page does not see a changed row it leaves out,** unless the row was
  re-hashed to hide the change. That is what "the verdict per page" means. A full walk
  stays with each module's verifier (Identity, Catalog, Fiscal), and scheduled chain
  checks of every module are Phase 69's.
