# 42. Posted records are reversed, never edited

- Status: accepted
- Date: 2026-09-15

## Context

The system already keeps an append-only audit log with a per-tenant hash chain (ADR 0025),
so it can prove what changed. That is necessary and not sufficient for financial records.
A receivable that was settled, a bank entry that was reconciled and a fiscal document that
was authorized are facts other parties rely on — a bank statement, a customer's own
ledger, a tax authority. Editing such a record makes the system's history disagree with
the world's.

The pressure to allow editing is real: an operator who typed the wrong amount wants to fix
it, and a correction flow is more work than an update endpoint. Without a decision, that
pressure resolves one endpoint at a time.

## Decision

Every financial, stock and fiscal record has a lifecycle with a point of no return.

Before that point — draft, forecast, requested — a record may be edited or deleted
outright. After it is posted, settled, reconciled, issued or authorized, it is immutable.

A correction after that point creates a **new linked record in the opposite direction**: a
settlement reversal, a credit entry, a stock counter-movement, a cancellation or a
correction document. The reversal references the original, and the original remains
visible and unchanged.

Every transition stores actor, instant, reason and correlation id in the audit log. A
reversal without a reason is rejected.

Deleting a posted record is not an operation. It is not exposed, not permitted to any
role, and not reachable from an administrative endpoint.

## Consequences

- Balances are always explainable as a sum of events, which is what makes the Ledger's
  replay and Treasury's journal invariants testable.
- The database grows faster than a mutate-in-place design, and reporting must net
  originals against reversals rather than reading the latest row.
- Screens must show reversal pairs honestly. A reversed title that renders as if it never
  existed is a defect, not a simplification.
- Operators need a correction flow with a reason field, permissions and its own tests, for
  each posted record type. This is part of the phase that introduces the record, not a
  later addition.
- Support and migration scripts lose the ability to quietly repair data, which is the
  intent.

## Alternatives considered

**Soft delete with an edit history.** Keeps the latest row convenient to read and keeps
history available for audit. Rejected because the current value is still a mutation: two
readers at different times see different "truth" for the same posted fact, and the bank
reconciliation that referenced the old amount becomes silently wrong.

**Full event sourcing for financial aggregates.** Would give the same guarantee and more.
Rejected as disproportionate: the system already has an outbox, an audit chain and
append-only journals, and event sourcing every aggregate would impose a rebuild and
versioning discipline on screens that are ordinary CRUD.

**Allowing edits within a short window.** Superficially humane. Rejected because the window
is either shorter than the mistake is noticed, or long enough that a reconciled record can
still change.
