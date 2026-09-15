# 46. Reconciliation suggests, a human confirms

- Status: accepted
- Date: 2026-09-15

## Context

Bank reconciliation is where the ERP's records meet an external system of record. A
statement line is a fact the bank asserts; a settlement is a fact the business asserts. The
job is to state which of them are the same event.

Matching is genuinely ambiguous. One transfer may pay several titles; one title may be paid
in several transfers; amounts differ by fees; dates differ by settlement lag; descriptions
are whatever the bank chose to send. Any rule that resolves this automatically will be
confidently wrong some fraction of the time, and each wrong match posts money against the
wrong party, which is expensive to find and expensive to undo.

Imports carry their own hazard: a user who imports the same statement twice, or a file that
overlaps the previous period, must not double the bank's history.

## Decision

Imported statements are **immutable**. The file's hash and each line's fingerprint are
stored, and re-importing the same file or the same line is a no-op, reported as such.
Normalization never discards the bank's identifiers or its original description.

Reconciliation supports one-to-one, one-to-many and many-to-one matches, partial matches,
explicitly ignored lines and explicitly created adjustments. Every match is reversible.

The system **suggests**; a person confirms. Suggestions are deterministic, built from
amount, date window, document identifier, counterparty and text similarity, and each
carries a score and a human-readable explanation of why it was proposed. No suggestion
posts by itself in the first release, at any confidence.

Acceptance and correction rates for suggestions are measured, because that evidence — not
an opinion about the matcher's quality — is what a later decision to auto-post would rest
on.

Bank feeds and Open Finance integrations sit behind an adapter port with the same
normalized output as a file import, so a provider is never a core-domain dependency.

## Consequences

- Reimporting a statement cannot create duplicates, and the property is directly testable.
- Reconciliation is auditable and undoable: what was matched, by whom, when, why, and what
  the state was before.
- Throughput is bounded by human confirmation. The workspace must therefore be fast —
  keyboard-first, filtered, with the difference always visible — because that is where the
  operator's time actually goes.
- Refusing to auto-post costs efficiency that competitors advertise. The measured
  acceptance rate is the intended path to revisiting it, with its own ADR.
- Statement lines never change, so a correction is an adjustment entry, consistent with
  ADR 0042.

## Alternatives considered

**Auto-match above a confidence threshold.** Attractive and common. Rejected for the first
release because a threshold is a guess until acceptance data exists, and the failure is
silent: a wrong auto-match looks exactly like a right one until a customer disputes a
balance.

**Trusting bank-provided matching or identifiers.** Some providers return a reference that
would make matching trivial. Rejected as a foundation: coverage varies by bank and by
product, and a design that depends on it degrades to nothing where it is absent.

**Reconciling by editing the statement to agree with the ERP.** Fast, and it destroys the
only independent record in the process.
