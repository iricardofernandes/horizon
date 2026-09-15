# 41. Financial, treasury and ledger are three boundaries

- Status: accepted
- Date: 2026-09-15

## Context

`docs/roadmap.md` declared one `financial/` module covering accounts payable and
receivable, bank reconciliation and reporting. Written as one service, that module would
own four unrelated rates of change: what a customer owes, what a bank account contains,
what the accounting position is, and how each is reported.

These have different invariants. A receivable's invariant is that its outstanding balance
equals its original amount plus additions minus reductions. A bank account's invariant is
that its balance equals its opening balance plus every entry in its journal. A ledger's
invariant is that every transaction balances to zero per currency. A single aggregate that
tries to hold all three either denies one of them or serializes unrelated work.

They also have different consistency requirements. Settling a title and moving money in a
bank account happen together from the user's point of view but belong to different
records; posting to the ledger must be replayable from history and must never block the
operational write.

## Decision

Three contexts, with stated ownership:

- `financial/` owns payable and receivable titles, installments, due dates, categories,
  allocations, approvals, settlement state and cash forecasts.
- `treasury/` owns bank, cash and clearing accounts, opening balances, the append-only
  account journal, internal transfers, statement imports and reconciliation.
- `ledger/` owns the chart of accounts, posting rules, balanced journal entries, period
  locking, the trial balance and the managerial DRE.

`financial/` and `treasury/` publish immutable business facts. `ledger/` consumes them
through idempotent consumers and never writes back. A user action may be synchronous
inside one context; every cross-context effect uses the outbox and inbox (ADR 0024).

Every money-moving command carries an idempotency key (ADR 0028).

Amounts remain non-negative `Money` values (ADR 0010). Direction — debit or credit,
inflow or outflow — is an explicit property of the entry, never the sign of an amount.

## Consequences

- Three services, three databases, three sets of contracts and more events to version. The
  cost is real and is accepted in exchange for invariants that can each be property-tested
  in isolation.
- Reconciliation between the three becomes a test rather than a hope: the sum of settled
  titles, the treasury journal and the ledger's cash accounts must agree, and a test can
  assert it.
- The ledger can be rebuilt by replaying events into an empty database, which is the only
  practical way to correct a posting-rule defect without editing history.
- A user-visible operation may complete in `financial/` before `ledger/` reflects it.
  Reports state their cutoff; they never imply an instantaneous global position.
- Direction as an explicit property means reversals are new entries in the opposite
  direction, never a negative amount, so `Money`'s non-negativity survives.

## Alternatives considered

**One `financial/` service, as the roadmap declared.** Fewer moving parts and one
transaction boundary. Rejected because bank reconciliation and double-entry posting would
share a schema with the subledger, and the first performance or correctness problem in one
would be indistinguishable from the others.

**Ledger-first, with double entry as the only representation.** Accounting-pure, and wrong
for the user: an operator works with titles, due dates and settlements, not with journal
lines, and every screen would need to reconstruct the operational concept from postings.

**Treasury inside financial, ledger separate.** Tempting, because settlements and bank
entries often happen together. Rejected because statement import and reconciliation carry
their own storage, adapters and failure modes, and they would dominate the subledger's
release cadence.
