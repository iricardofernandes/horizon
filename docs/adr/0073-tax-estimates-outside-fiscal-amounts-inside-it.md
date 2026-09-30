# 73. Tax estimates outside Fiscal, amounts inside it

- Status: accepted. To be implemented in Phase 87.
- Date: 2026-09-30

## Context

Sales totals carry no tax, and Procurement receives an order's tax as one typed amount. A
tax shown on a quote or a purchase order helps a decision, but it is not the tax owed:
that is fixed only when Fiscal locks a document's calculation.

## Decision

- **Sales and Procurement ask Fiscal for a preview,** show it labeled as an estimate, and
  keep its digests.
- **A preview never locks and never transmits** (Phase 41).
- **Only a Fiscal calculation lock reaches Financial and Ledger as tax amounts.** Its
  components travel on the fiscal document's event, and contracts carry summaries
  (component, amount, digest), never rules.

## Consequences

- Other modules never calculate tax, and never need the rules.
- An estimate can differ from the locked amount, and both are recorded, so the difference
  is visible.

## Alternatives considered

**Letting Sales calculate from a copy of the rules.** Rejected: two engines drift, and the
second one would bypass the evidence of ADR 0072.
