# 76. Taxes are posted when the authority authorizes, and an estimate is kept by reference

- Status: accepted. Implemented in Phase 91 ([plan](../security-logic-plan.md)). Supersedes
  two points of [ADR 0073](0073-tax-estimates-outside-fiscal-amounts-inside-it.md): when the
  Ledger posts a lock, and how Sales and Procurement come to hold an estimate.
- Date: 2026-10-03

## Context

ADR 0073 had the Ledger post a sale's taxes when Fiscal locked the document, once per origin
and purpose, and had the web hand Fiscal's estimate to Sales and Procurement.

- **A lock is not an authorization.** A locked document may be rejected. Its correction is a
  new document from a new intent, with a new origin id, so the "once per origin" key did
  not hold: the rejected document's taxes stayed in the books and the corrected one posted
  again. A cancelled document's taxes were never reversed.
- **An estimate was whatever the browser sent.** Sales and Procurement checked its shape
  only. In Procurement it replaced the order's tax, was shown to the approver as Fiscal's,
  and reached Fiscal as "its own estimate", the value a supplier's NF-e is compared with.
  A buyer could make an overcharged invoice reconcile clean. In Sales, an estimate stayed on
  a draft after its lines changed.

## Decision

1. **The Ledger posts a document's taxes when the authority authorizes it.**
   - The lock waits as a `held` fact, keyed by the document, neither posted nor replayed.
   - The authorization posts it. A cancellation reverses what was posted. A rejected
     document never posts, and its correction is a document of its own.
   - The lock and the answer may arrive in either order, so the Ledger keeps the answer
     for each document. It only moves forward, from authorized to cancelled.
   - While Fiscal only simulates, the simulator's authorization is the authorization.
     Homologation, a manual simulation and a document of Fiscal's own origin still post
     nothing.
2. **Fiscal keeps every estimate it issues,** with the request it answered, and returns it
   by its `resultDigest` to a reader of its tenant.
3. **Sales and Procurement take only the digest.** They read the estimate back from Fiscal
   through the gateway, with the caller's token, and keep it only if Fiscal was asked
   about this very document: its direction, its party, and the same lines with their
   quantities and prices. The comparison and the write share one transaction, with the
   document locked.
4. **An estimate is of the lines it was asked for.** Revising a draft removes it, in Sales
   as in Procurement, and a sent quote takes no new one.
5. **Fiscal trusts only its own record.** A purchase order's digest is projected only when
   Fiscal issued an estimate under it for that supplier and those lines, with the
   components Fiscal kept, never the ones the order carries. A supplier's NF-e is compared
   with nothing else.

## Consequences

- The books show a sale's taxes only for documents the authority took, once each, and
  net to zero for a cancelled one.
- Sales and Procurement now depend on Fiscal, through the gateway, at the moment an
  estimate is kept, and answer `503` when it cannot be asked. Nothing else in either
  module waits for Fiscal.
- The caller needs read access to Fiscal to keep an estimate, which whoever asked Fiscal
  for it already has.
- Postings made at the lock before Phase 91 stay as they are. They are keyed by origin, and
  no later cancellation finds them. The repository has only ever run in simulation; a
  workspace that needs them corrected reverses them by hand.
- Fiscal keeps estimates as it keeps calculations; no retention applies to them yet.

## Alternatives considered

- **Keep posting at the lock, and reverse on rejection and cancellation.** Rejected by the
  workspace owner: every rejection would leave a posting and its reversal in the books, for
  a tax that was never owed.
- **Have Fiscal sign each estimate, and verify the signature in the owner.** Rejected by the
  workspace owner: it needs a new key, its distribution and its rotation, where one read
  through the gateway gives the same guarantee.
- **Bind an estimate to a document id and version.** Not needed: an estimate asked for the
  same party and lines is the same estimate, and one asked for other lines is refused.
