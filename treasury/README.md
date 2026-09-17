# `treasury/`

Bank, cash, card-clearing and virtual accounts, their append-only journal, balances and
internal transfers.

An independently deployable NestJS service with its own database, its own container and
its own lifecycle. It is reached through Kong at `/treasury`, never directly, and it shares
no source with any other module (ADR 0001). Its boundary against `financial/` and `ledger/`
is ADR 0041.

**Status: phase 20 — accounts, journal, balances, transfers, statement import and
reconciliation complete.**

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
- **Statements** — OFX and CSV files imported into an account through pluggable adapters.
  A file is recognised by its hash and each line by its fingerprint, so reimports and
  overlapping files store nothing twice. Lines are immutable and keep the bank's own fields.
- **Reconciliation** — a person matches bank lines to entries (one to one, one to many, many
  to one, partially, or with an explicit adjustment entry), or ignores lines with a reason.
  Deterministic suggestions carry a score and their reasons and never confirm themselves.
  Every reconciliation balances, is undone rather than deleted, and a closed period freezes
  the ones it covers (ADR 0046).
- **Balances** — always computed from the journal by value date: the book balance through a
  date, the projected balance including later-dated entries, the reconciled balance, and the
  last balance a bank statement reported. There is no stored balance to drift, so a backdated
  entry moves every later balance deterministically.

A book balance is labelled as such everywhere. It is never presented as the bank's live
balance; the statement balance is the bank's figure on the date its file reported it.

## Events

| Event | Meaning |
|---|---|
| `treasury.account.opened` | An account started keeping a journal |
| `treasury.entry.recorded` | A line was appended — including every transfer leg, fee and reversal |
| `treasury.transfer.posted` | Money moved between two accounts, both legs committed |
| `treasury.transfer.cancelled` | A transfer was undone by inverse entries |
| `treasury.statement.imported` | A statement file was imported; duplicates are counted, not stored |
| `treasury.reconciliation.confirmed` | A person matched or ignored bank lines |
| `treasury.reconciliation.undone` | A reconciliation was undone |

It consumes `financial.settlement.recorded` and `financial.settlement.reversed`: a settlement
that names a treasury account becomes, or stops being, that account's journal entry, and a
settlement the account cannot take is recorded as refused with its reason. Every command that moves money requires an `Idempotency-Key`
header (ADR 0028), and every command is written to a per-tenant hash-chained audit log.

## Authorization

| Role | Reads | Records entries, transfers, imports and reconciliations | Reverses, cancels and undoes | Opens accounts, closes and reopens periods |
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
directions keeping money constant, the deferred leg constraint, the append-only journal,
statement reimports, every reconciliation shape, suggestions and their measurement, the
period summary, period closure and tenant isolation.
