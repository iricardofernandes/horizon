# `financial/`

Payables, receivables, settlements, and the dimensions they are classified by.

An independently deployable NestJS service with its own database, its own container and
its own lifecycle. It is reached through Kong at `/financial`, never directly, and it
shares no source with any other module (ADR 0001). Its boundary against `treasury/` and
`ledger/` is ADR 0041.

**Status: phase 16 — dimensions complete.** Titles, installments and settlements arrive in
the next phase.

---

## What this context owns today

- **Financial categories** — a revenue and expense tree, at most four levels deep, where a
  child always shares its parent's nature.
- **Departments and projects** — the analytic dimensions amounts are allocated to.
- **Payment methods** — cash, bank transfer, Pix, boleto, cards, check.
- **Payment terms** — installment templates whose shares total exactly 100%.
- **Allocation** — dividing an amount across dimensions by percentage without losing or
  inventing a minor unit.

Every registry entry is deactivated, never deleted: documents keep what they used.

## What it explicitly does not own

- Bank accounts, balances, transfers and reconciliation — `treasury/`.
- Journal entries, periods and the DRE — `ledger/`.
- Who the counterparties are — `parties/`.

## Authorization

`financial:admin` reads and configures; `financial:operator` and `financial:viewer` read.

## Running it

```sh
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

`npm test` runs the domain tests, including a property test over a thousand random money
splits; `npm run test:e2e` starts PostgreSQL with Testcontainers and proves the category
tree, per-workspace uniqueness, schedule and allocation previews, and tenant isolation.
