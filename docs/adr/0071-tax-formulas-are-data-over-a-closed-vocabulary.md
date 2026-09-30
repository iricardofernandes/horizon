# 71. Tax formulas are data over a closed vocabulary

- Status: accepted. To be implemented in Phase 83.
- Date: 2026-09-30

## Context

Phase 41's only formulas multiply a rate by a line's or document's net amount. Brazilian
taxes need more:
- bases composed of freight, insurance, other expenses and discounts;
- gross-up (a base that includes the tax itself);
- base reductions;
- outcomes that are not amounts (exempt, suspended, deferred);
- taxes on other taxes, in an order.

Writing each case as code would make every rate change a deployment and every formula a
review of code rather than of data.

## Decision

- **A component's formula is an expression tree.** It works over named bases (net,
  freight, insurance, other expenses, discount, and other components' results) and
  rational rates. The only operations are sum, product, gross-up, reduction, minimum and
  maximum.
- **Exempt, suspended, deferred and not levied are values** the formula returns, not
  errors.
- **Components depend on one another in a declared order.** A cycle, an unknown base or a
  tree over the size limit refuses the package when it is published, never when a
  document is calculated.
- **There is no user code, no `eval`, no loop and no conditional inside a formula.**
  Conditions belong to rule scope and precedence.
- **The explanation records every step with its value** (`fiscal-explanation-v2`).
  Version 1 explanations and locks replay unchanged.

## Consequences

- A new tax treatment is a new package version, reviewed as data.
- The interpreter is pure and small enough to property-test for determinism and the
  absence of floating point.
- The vocabulary grows only by ADR.

## Alternatives considered

**A general expression language, or JavaScript in a sandbox.** Rejected: it cannot be
reviewed as tax law, and its determinism and termination would have to be proven for
every package.
