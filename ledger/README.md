# `ledger/`

The general ledger: the chart of accounts, the double-entry journal, accounting periods and
the trial balance.

An independently deployable NestJS service with its own database, its own container and its
own lifecycle. It is reached through Kong at `/ledger`, never directly, and it shares no
source with any other module (ADR 0001). Its boundary against `financial/` and `treasury/`
is ADR 0041: those two own what is owed and where the cash is, and the ledger owns what all
of it means in accounting terms.

**Status: phase 25 — chart of accounts, balanced journal, periods, the automatic postings
raised from `financial/` and `treasury/` facts, and the reports they add up to.**

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
- **Automatic postings** — a receivable, a payable, a settlement, an internal transfer and
  the treasury entries no other fact covers become balanced transactions as they are
  reported. The rules are fixed code, because a posting rule is accounting policy and a
  rule engine a workspace can edit is a ledger nobody can audit. What a workspace chooses
  is which of its accounts plays each part.
- **Pending facts** — a fact the workspace cannot post yet, because a category has no
  account or the month is closed, waits with the numbers it arrived with and is replayed
  once the workspace fixes it. The queue never blocks, and nothing is lost.
- **Reports** — the chart with each account's balance and its subtree's total; the trial
  balance (opening, movement and closing per account, with the two totals it exists to
  compare); the result of a period by account, revenue and expense both reading positive;
  realised cash flow by day, week or month over the accounts mapped as cash; and one
  account's lines with the balance each left behind.
- **Drill-down** — every line names the fact it accounts for, so a figure in a report leads
  to the account, the account to its lines, and each line back out to the receivable,
  settlement or transfer behind it.

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

It consumes `financial.receivable.posted`, `financial.payable.posted`, their reversals,
`financial.settlement.recorded` and `financial.settlement.reversed`,
`treasury.transfer.posted`, `treasury.transfer.cancelled` and `treasury.entry.recorded`.
Every command requires an `Idempotency-Key` header (ADR 0028), and every command is written
to a per-tenant hash-chained audit log.

## The posting rules

| Fact | Debit | Credit |
|---|---|---|
| Receivable posted | receivables | revenue, by the title's category |
| Payable posted | expense, by the title's category | payables |
| Receivable settled | cash, discount granted | financial income, receivables (net) |
| Payable settled | payables (net), financial expense | cash, discount received |
| Internal transfer | the destination cash account, bank fees | the source cash account |
| Treasury opening balance | cash | opening balance |
| Manual treasury entry | cash or suspense | suspense or cash |

A settlement's receivable or payable leg is the *net* of the cash and the discount less the
interest and penalty, and takes whichever side that net calls for: a settlement that charges
more interest than it collects cash raises what the party owes rather than lowering it.

Moving money between two of the workspace's own accounts changes nothing it owns, so a
transfer never touches profit or loss. The fee the bank charges for moving it does.

A transfer leg, its fee, a settlement and a reversal all reach the ledger through the fact
that caused them, so the treasury journal lines for those are deliberately ignored —
posting them as well would count each of them twice.

Resolution of an account is exact, then the role's default, then suspense. Suspense keeps
the books complete when a category has no account yet: the transaction still balances, and
the accountant reclassifies it.

## Authorization

| Role | Reads | Posts, reverses and replays | Opens accounts, maps them, closes and reopens months |
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

`npm test` runs the domain tests, including property tests that debits equal credits after
every posting and every reversal across the whole chart, and that every combination of
cash, discount, interest and penalty a settlement can carry plans a balanced transaction.

The reports are read at query time from the lines, never from a stored total, so two
consecutive periods always add up to the one that spans both — which is asserted rather
than assumed. What counts as cash is not guessed from account names: it is exactly the
accounts mapped to the `cash` part of the postings, so a report and a posting can never
disagree about what cash is.

`npm run test:e2e` starts PostgreSQL with Testcontainers and proves the chart's tree and its
roll-ups, the trial balance, idempotent commands, the running balance of an account,
reversal into a later month, a closed month refusing postings and reversals until reopened,
the deferred balance constraint, the append-only lines under both the application and the
owner role, tenant isolation — and, for the automatic postings, that a fact posts exactly
one transaction however often its event is delivered, that a fact the workspace cannot post
yet waits and then posts on replay, that a fact reversed while pending is never posted at
all, and that replaying every event into an empty ledger, in any order and twice over,
produces the same balances — and that the reports reconcile with the facts they were built
from: revenue equals what was invoiced, closing cash equals what was collected, the
receivables account holds exactly the difference, and every line of it names the fact that
put it there.
