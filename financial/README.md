# `financial/`

Payables, receivables, settlements, and the dimensions they are classified by.

An independently deployable NestJS service with its own database, its own container and
its own lifecycle. It is reached through Kong at `/financial`, never directly, and it
shares no source with any other module (ADR 0001). Its boundary against `treasury/` and
`ledger/` is ADR 0041.

**Status: phase 24 — receivables and payables with approvals, and forecasts that
invoicing turns into effective titles.**

---

## What this context owns today

- **Titles** — receivables and payables with installments, issue, competence and due dates, a revenue
  category, allocations and an origin (manual or a sales order). A draft is revised or
  cancelled; a posted title is settled or reversed and never edited (ADR 0042).
- **Forecasts** — money the workspace expects rather than is owed: a confirmed sales order
  becomes a forecast receivable, and invoicing turns *that same title* effective. Because
  the stage changes in place, the expected money and the claim on the customer are never
  both counted at once. A forecast never posts, so it never counts as a receivable, never
  reaches the ledger, and appears in no view but its own.
- **Approvals** — a payable at or above the workspace policy's threshold posts only after a
  financial admin other than the requester approves it; a rejection carries a reason.
- **Settlements** — cash received or paid against one installment, with discount, interest and
  penalty. A settlement is reversed with a reason, never deleted.
- **Audit** — a per-tenant hash-chained log of every transition, shown as each title's
  history (ADR 0025).
- **Financial categories** — a revenue and expense tree, at most four levels deep, where a
  child always shares its parent's nature.
- **Departments and projects** — the analytic dimensions amounts are allocated to.
- **Payment methods** — cash, bank transfer, Pix, boleto, cards, check.
- **Payment terms** — installment templates whose shares total exactly 100%.
- **Allocation** — dividing an amount across dimensions by percentage without losing or
  inventing a minor unit.

Every registry entry is deactivated, never deleted: documents keep what they used.

## Events

| Direction | Event | Effect |
|---|---|---|
| Consumes | `parties.party.registered`, `.updated`, `.erased` | Maintains the party projection; erasure destroys the projected name |
| Consumes | `sales.order.confirmed` | Raises one draft receivable per order |
| Consumes | `sales.order.cancelled` | Cancels that draft if it was never posted |
| Publishes | `financial.receivable.posted`, `.reversed` | A claim on a customer began or was undone |
| Publishes | `financial.payable.posted`, `.reversed` | An obligation to a supplier began or was undone |
| Publishes | `financial.settlement.recorded`, `.reversed` | Money was received or paid, or that was undone; with a treasury account, Treasury records the cash |

Posting, settling and every reversal require an `Idempotency-Key` header (ADR 0028).

## What it explicitly does not own

- Bank accounts, balances, transfers and reconciliation — `treasury/`.
- Journal entries, periods and the DRE — `ledger/`.
- Who the counterparties are — `parties/`.

## Authorization

| Role | Reads | Drafts, posts, settles, requests approval | Reverses, approves | Configures registries and approval policy |
|---|---|---|---|---|
| `financial:admin` | yes | yes | yes | yes |
| `financial:operator` | yes | yes | — | — |
| `financial:viewer` | yes | — | — | — |

## Running it

```sh
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

`npm test` runs the domain tests, including property tests over a thousand random money
splits and over random settlement histories; `npm run test:e2e` starts PostgreSQL with
Testcontainers and proves the category tree, schedule and allocation previews, idempotent
commands, database-enforced immutability of settlements, the audit chain, the sales-order
and parties projections, and tenant isolation.
