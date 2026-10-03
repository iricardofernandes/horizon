# Phase 91 evidence — Taxes follow the authority, and estimates Fiscal vouches for

[Plan](security-logic-plan.md#phase-91--taxes-in-the-books-follow-the-authority-and-estimates-fiscal-vouches-for) ·
[ADR 0076](adr/0076-taxes-follow-the-authority-and-estimates-are-kept-by-reference.md)

Findings 3, 4, 5 and 12 of the [security and logic review](security-logic-plan.md), and one
more found on the way. The workspace owner decided both open points on 2026-10-02: taxes
are posted at the authorization, and estimates are kept by reference.

## Before and after

| | Before | After |
|---|---|---|
| When a sale's taxes are posted | at Fiscal's lock, once per origin | when the document is authorized, once per document |
| A locked document that is rejected | its taxes stayed in the books | never posts |
| Its correction | posted again, beside the rejected one | posts once, with its own amounts |
| A cancelled document | its taxes stayed | reversed, so they net to zero |
| What Sales and Procurement keep as Fiscal's estimate | whatever body the browser sent | what Fiscal returns under the digest, and only when it is of the document's party and lines |
| A draft quote revised after its estimate | kept the old estimate | the estimate is removed |
| A sent quote | took a new estimate | takes none |
| What Fiscal compares a supplier's NF-e with | the components the purchase order carried | the estimate in its own record, for that supplier and those lines |
| Two rule changes decided at once in a workspace | each checked without the other; the second hit the database guard as a raw error | decided one at a time; the second is refused as a rule change |

## Proof

- **Ledger,** against real PostgreSQL (46 e2e tests, 7 of them new) and 6 unit tests:
  - a lock is held and nothing is posted until the authorization, which posts it once;
  - lock, reject, correct, authorize: one posting, with the corrected amounts;
  - lock, authorize, cancel: the posting and its reversal, and taxes payable at zero;
  - the answer before the lock: an authorized one posts when the lock arrives, a
    cancelled one never does;
  - an NFC-e posts on its own outcome event, and a return posts negative amounts;
  - a manual simulation, a homologation drill and a sale with no tax in its price post
    nothing, authorized or not;
  - the database refuses an answer that moves backwards.
- **Fiscal:**
  - the API returns an estimate it issued by its digest to a reader of the tenant, `404`
    for a digest it never issued, `403` without read access;
  - a purchase order whose digest Fiscal issued, for that supplier and those lines, is
    compared component by component, with Fiscal's own components;
  - a forged digest, an estimate issued for another supplier, and one for other lines are
    each compared with nothing;
  - two rule changes that tie, approved at once: one is applied and the other refused with
    `RuleChangeRefused`. Without the workspace lock the same test fails, on a raw
    `PostgresError` from the database guard.
- **Sales,** against real PostgreSQL: an estimate asked for another customer or other
  quantities is a `mismatch`; the right one is kept; revising the draft removes it, and the
  old request no longer matches; a sent or accepted quote is `frozen`.
- **Procurement,** against real PostgreSQL: an estimate of another supplier or of other
  lines is refused and the order keeps none; the right one replaces the typed tax and is
  carried on approval; a committed order takes none.
- **Contracts 0.64.0:** the reference takes a digest and nothing else; the record carries
  only a supported estimate; the matcher takes the same lines in any order, whatever zeros
  a quantity carries, and refuses another party, direction, price, quantity, discount or
  line.
- **The Phase O golden path** (`make phase-o-golden-path`), through Kong on the rebuilt
  stack: a forged digest and a whole relayed estimate are each `400`; the digest of the
  estimate Fiscal issued is kept and carried to the order; the lock is held and posts
  nothing.
- **The Phase 48 golden path** on the same stack: a Sales NF-e is authorized in
  simulation, and the Ledger records the authorization for its document.

## Gates

- `node scripts/ci-local.mjs --full`, after the last edit: every check, clean installs,
  typecheck, lint, tests and build of every project, the e2e suites of all sixteen
  services, and every Docker image.
- `make demo`, twice, `make test-phase10`, `make test-alerts` and the Phase 90 smoke
  (14 of 14) on the rebuilt stack.
- Terraform `fmt`, and its tests with the dev and prod variables, for the gateway address
  Sales and Procurement now receive.
- `deck` did not run: `gateway/kong.yml` is unchanged.

## Found on the way

1. **A draft quote could not be revised, nor sent for a discount approval.** Saving a
   `draft` or `pending` quote rewrites its lines, and the application role never had
   `DELETE` on `quote_lines`: both failed against the database. The unit tests use
   in-memory repositories and never saw it. The new e2e test revises a draft, and
   migration 0020 grants the delete.
2. **The database already refused two rules that tie.** Finding 12's effect was a raw
   error instead of a refusal, not two tied rules in force.
3. **Each estimate has a digest of its own.** The calculation input carries line ids
   generated per request, so a digest names one request and one answer.

## Not done, and why

- No run on the local stack shows a posting at an authorization. The simulation profile
  issues only the items it names; the Phase O golden path's item is new, so its document
  cannot be issued, and the Phase 48 document carries only reform taxes, which are not
  posted. The posting, the correction and the reversal are proven by the Ledger's e2e suite.

- Postings made at the lock before this phase are not migrated. They are keyed by origin,
  and the Ledger cannot tell which document each came from.
- An estimate is bound to its document by content, its party and lines, not by an id and
  version as the plan said: the same party and lines have the same taxes.
- Fiscal's estimates have no retention.
