# Controls API reference

The internal controls of Phase M, as the Phase 70 screens use them:
- segregation of duties and delegation
  ([ADR 0062](adr/0062-segregation-of-duties-is-a-declared-matrix.md), Phase 68);
- approval thresholds and the queues that wait for a second person;
- the audit read;
- consistency checks ([ADR 0063](adr/0063-recovery-is-measured-by-drills.md), Phase 69).

The shared shapes are published in `@horizon/contracts` 0.51.0 (`http/controls.ts`). Through
Kong every path is prefixed with its module.

## Segregation of duties

Each module enforces its own pairs. A refused pair always answers the same way:

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json

{ "type": "https://horizon.dev/problems/segregation-of-duties", "status": 403,
  "code": "segregation-of-duties", "pair": "treasury.transfer",
  "detail": "the person who asked for a transfer cannot decide it" }
```

| Pair | Module | Performs | Approves |
|---|---|---|---|
| `financial.payable` | Financial | `financial:payable:create` | `financial:payable:approve` |
| `procurement.requisition` | Procurement | `procurement:requisition:create` | `procurement:requisition:approve` |
| `procurement.order` | Procurement | `procurement:order:create` | `procurement:order:approve` |
| `procurement.requisition-order` | Procurement | `procurement:requisition:create` | `procurement:order:approve` |
| `inventory.adjustment` | Inventory | `inventory:adjustment:create` | `inventory:adjustment:approve` |
| `inventory.count` | Inventory | `inventory:count:close` | `inventory:count:approve` |
| `ledger.entry` | Ledger | `ledger:entry:create` | `ledger:entry:approve` |
| `treasury.transfer` | Treasury | `treasury:transfer:create` | `treasury:transfer:approve` |

## Delegations

In `financial`, `procurement`, `inventory`, `ledger` and `treasury`.

| Route | Role | Does |
|---|---|---|
| `GET /delegations` | any role in the module | the tenant's delegations, with their state now |
| `POST /delegations` | a role that approves | lends an approval the caller holds |
| `POST /delegations/{id}/revoke` | the lender, or someone who holds the approval | ends it now |

```json
POST /ledger/delegations
{ "permission": "ledger:entry:approve", "delegateId": "01a0…",
  "startsAt": "2026-10-01T00:00:00.000Z", "endsAt": "2026-10-15T23:59:59.999Z",
  "reason": "Férias" }
```

- **At most 90 days.** A longer absence is a role change.
- **States:** `scheduled`, `active`, `ended` and `revoked`.
- **The delegate still needs a role** in the module, and never decides what they asked for.
- **A decision made through a delegation** records `decided_for`, the person who lent it.

## Approval thresholds

| Route | Role | Does |
|---|---|---|
| `GET /ledger/approval-policies` | any Ledger role | the thresholds per currency |
| `PUT /ledger/approval-policies` | Ledger `admin` | sets one: `{ "currency": "BRL", "threshold": "100000" }` |
| `GET /treasury/approval-policies` | any Treasury role (since Phase 70) | the thresholds per currency |
| `PUT /treasury/approval-policies` | Treasury `admin` | sets one |

- **Units:** thresholds are minor units.
- **Above the threshold:** a manual entry (Ledger) answers `202` and waits; a transfer
  (Treasury) is `pending`.
- **Without a threshold** for a currency, nothing waits.

## Queues

| Route | Does |
|---|---|
| `GET /ledger/manual-entries?status=pending` | manual entries waiting |
| `POST /ledger/manual-entries/{id}/approve` | posts the entry |
| `POST /ledger/manual-entries/{id}/reject` | `{ "reason": "…" }`, at least 3 characters |
| `GET /treasury/transfers` | transfers, the `pending` ones included |
| `POST /treasury/transfers/{id}/approve` | posts both legs |
| `POST /treasury/transfers/{id}/reject` | `{ "reason": "…" }`; no money moved |

- **Who reaches a decision:** any role in the module, because an approval may be delegated.
  The module decides whether the person may.
- **The requester is refused** with the pair above. A pending transfer cannot be cancelled.

## Audit

`GET /audit` in every module with an audit log (Files: `GET /files/audit`).
- **Readers:** the module's `admin`, or its `auditor` (Files: `identity:auditor`).
- **Filters:** `actor`, `action`, `subjectType`, `subjectId`, `from`, `to`, `cursor` and
  `limit`.
- **Each page** carries `chain.status` (`intact` or `broken`), the rows checked, and the
  broken rows.

The web merges every module the person may read at `/api/audit`, and exports them as CSV.

## Consistency checks

| Route | Role | Does |
|---|---|---|
| `GET /reporting/consistency-checks?limit=` | Reporting `admin`, `analyst` or `viewer` | the runs, newest first |
| `POST /reporting/consistency-checks` | Reporting `admin` or `analyst` | runs the checks now, with the caller's token |

- **The checks:** `receivables-control`, `payables-control`, `cash-accounts`,
  `inventory-accounts` and `audit-chains`.
- **Check outcomes:** `matched`, `differences`, `not-applicable` or `unread`.
- **Differences** name a key (a currency, or a module for chains) and both figures.
- **The run** is `consistent`, `inconsistent` or `incomplete`.
- **The daily run** is `service:reporting`, with a token from `POST /auth/service-token`.

## Retention

Retention has no API. `tooling/retention` applies `policy.json`, and `make retention-now`
runs one pass. The controls screen shows the classes read-only.
