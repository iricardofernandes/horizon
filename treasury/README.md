# `treasury/`

Bank, cash, card-clearing and virtual accounts, their append-only journal, balances and
internal transfers.

An independently deployable NestJS service with its own database, its own container and
its own lifecycle. It is reached through Kong at `/treasury`, never directly, and it shares
no source with any other module (ADR 0001). Its boundary against `financial/` and `ledger/`
is ADR 0041.

**Status: phase 19 — accounts, journal, balances and transfers complete.** Statement import
and reconciliation arrive next.

---

## What this context owns

- **Accounts** — bank (with bank code, branch and account number), cash, card clearing and
  virtual, each in one currency and tracked from a calendar date. Deactivated, never deleted.
- **The journal** — one append-only line per movement, with a direction instead of a sign,
  a value date and a source: opening balance, manual entry, transfer leg, transfer fee or
  reversal. A manual entry is corrected by a reversal naming it; nothing is edited.
- **Transfers** — one aggregate whose outflow, inflow and optional fee legs are written in
  the transaction that records it. A deferred database constraint refuses a transfer that
  commits without both legs. Cancelling adds inverse entries and keeps the originals.
- **Balances** — always computed from the journal by value date: the book balance through a
  date, the projected balance including later-dated entries, and the reconciled balance
  (zero until reconciliation exists). There is no stored balance to drift, so a backdated
  entry moves every later balance deterministically.

A book balance is labelled as such everywhere. It is never presented as the bank's live
balance; an imported statement balance arrives with reconciliation.

## Events

| Event | Meaning |
|---|---|
| `treasury.account.opened` | An account started keeping a journal |
| `treasury.entry.recorded` | A line was appended — including every transfer leg, fee and reversal |
| `treasury.transfer.posted` | Money moved between two accounts, both legs committed |
| `treasury.transfer.cancelled` | A transfer was undone by inverse entries |

It consumes nothing yet. Every command that moves money requires an `Idempotency-Key`
header (ADR 0028), and every command is written to a per-tenant hash-chained audit log.

## Authorization

| Role | Reads | Records entries and transfers | Reverses and cancels | Opens and deactivates accounts |
|---|---|---|---|---|
| `treasury:admin` | yes | yes | yes | yes |
| `treasury:operator` | yes | yes | — | — |
| `treasury:viewer` | yes | — | — | — |

## Running it

```sh
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

`npm test` runs the domain tests, including a property test that the book balance and the
daily timeline come out the same whatever order backdated entries are recorded in.
`npm run test:e2e` starts PostgreSQL with Testcontainers and proves statements with running
balances, idempotent commands, transfer cancellation, concurrent transfers in both
directions keeping money constant, the deferred leg constraint, the append-only journal and
tenant isolation.
