# `ledger/`

The general ledger: the chart of accounts, the double-entry journal, accounting periods and
the trial balance.

An independently deployable NestJS service with its own database, its own container and its
own lifecycle. It is reached through Kong at `/ledger`, never directly, and it shares no
source with any other module (ADR 0001). Its boundary against `financial/` and `treasury/`
is ADR 0041: those two own what is owed and where the cash is, and the ledger owns what all
of it means in accounting terms.

**Status: phase 22 — chart of accounts, balanced journal, periods and trial balance
complete. Postings raised automatically by other modules arrive in the next slice of
Phase F.**

---

## What this context owns

- **The chart of accounts** — a tree of asset, liability, equity, revenue and expense
  accounts, each identified by a dotted code (`1.01.001`) that *is* its place in the tree.
  Only a leaf is `postable`; a parent exists to total its children and never takes a line
  of its own, which both the domain and a database trigger enforce. An account is
  deactivated, never deleted, and its code and place never change: every line already
  posted refers to them.
- **The journal** — balanced transactions, each in one currency, with at least two lines
  and debits equal to credits. Balance is checked in the aggregate, so an unbalanced
  transaction never exists as an object, and again by a deferred database constraint, so
  one cannot be committed even by code that bypasses the domain.
- **Reversals** — a posted transaction is never edited. A correction is a mirror
  transaction with every side swapped, which leaves every account exactly where it was
  (ADR 0042). A transaction is reversed once, a mirror is never reversed, and a mirror may
  be dated into a later month when the original's month has already been reported.
- **Accounting periods** — calendar months. Closing one refuses every posting into it and
  every reversal inside it; reopening keeps who did it and why. A month with no record has
  never been closed, so a new ledger writes nothing until someone decides something.
- **Reports** — the chart with each account's balance and its subtree's total, the trial
  balance (opening, movement and closing per account, with the two totals it exists to
  compare), and one account's lines with the balance each left behind.

Every balance is computed from the lines by posting date. There is no stored balance to
drift, so a backdated transaction moves every later balance deterministically.

## Events

| Event | Meaning |
|---|---|
| `ledger.account.opened` | An account was added to the chart |
| `ledger.transaction.posted` | A balanced transaction was posted, with all of its lines |
| `ledger.transaction.reversed` | A transaction was undone by its mirror |
| `ledger.period.closed` | A month stopped taking postings |
| `ledger.period.reopened` | A closed month was reopened, with the reason |

It consumes nothing yet, so it has no queue. Every command requires an `Idempotency-Key`
header (ADR 0028), and every command is written to a per-tenant hash-chained audit log.

## Authorization

| Role | Reads | Posts and reverses | Opens accounts, closes and reopens months |
|---|---|---|---|
| `ledger:admin` | yes | yes | yes |
| `ledger:accountant` | yes | yes | — |
| `ledger:viewer` | yes | — | — |

Reversing is ordinary accounting work rather than an escalation, because it never destroys
the original. Changing the chart decides what every report can ever say, and closing a
month freezes what everyone else may post, so both stay with admins.

## Running it

```sh
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

`npm test` runs the domain tests, including a property test that debits equal credits after
every posting and every reversal, across the whole chart. `npm run test:e2e` starts
PostgreSQL with Testcontainers and proves the chart's tree and its roll-ups, the trial
balance, idempotent commands, the running balance of an account, reversal into a later
month, a closed month refusing postings and reversals until reopened, the deferred balance
constraint, the append-only lines under both the application and the owner role, and tenant
isolation.
