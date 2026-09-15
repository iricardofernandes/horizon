# 43. Precision beyond the minor unit: scaled rates, business dates and rounding snapshots

- Status: accepted
- Date: 2026-09-15

## Context

ADR 0010 settled money as an integer count of minor units with an explicit currency, and
ADR 0011 settled `timestamptz` with UTC storage. Both hold. The financial and fiscal
contexts add three questions that neither answers.

First, not every number in a financial document is a money amount. A unit price may carry
more decimal places than the currency has minor units; a tax rate, an interest rate per
day and a penalty rate are ratios, not amounts. Rounding them to minor units before
multiplying is how a line total drifts from what a customer's own system computes.
`Quantity` already solved the same problem in `sales/` by storing micros — an integer at
scale 6 — and that pattern is the answer here too.

Second, a due date is not an instant. `timestamptz` forces a time and a zone onto a value
that has neither: a title due on the 10th is due on the 10th regardless of where the
reader is. Storing it as an instant means a user in another timezone sees the 9th.

Third, rounding is a per-operation decision (ADR 0010), which means a posted document
computed under one rule must not silently recompute under another when the rule changes.

## Decision

**Money is unchanged.** `Money` — integer minor units plus currency — remains the only
representation of an amount, in every context. Finance introduces no second money type and
no decimal string amounts.

**Rates and unit prices are scaled integers** with a declared scale, held in value objects
that validate their input and expose their scale, as `Quantity` does with micros. The scale
is a property of the value object, never an implicit assumption at a call site. Converting
a scaled value into `Money` is an explicit operation that names its rounding mode.

**Business dates are date-only columns.** Issue, competence, due, value and posting dates
are calendar dates with no time and no zone. Instants — created, posted, reconciled,
authorized — remain `timestamptz` in UTC. A screen never converts a business date across
timezones.

**Posted documents snapshot their rounding.** When a document is posted, the rounding mode
used for each computed amount is stored with it. Recomputing a posted document uses its
stored rounding, not today's configuration.

## Consequences

- No monetary path gains a float or a decimal string, so ADR 0010's guarantee survives the
  arrival of tax rates and interest.
- Each context defines its own scaled value objects, as it already defines its own `Money`
  and `Quantity`; the projects stay independent (ADR 0001) at the cost of a repeated
  pattern that the contracts package encodes once on the wire.
- Due dates behave the same for every reader, and "overdue" is a comparison of calendar
  dates in the workspace's timezone, computed once at the boundary.
- Stored rounding makes posted documents reproducible, and makes a rounding-rule change a
  forward-only event rather than a silent rewrite of history.
- Two representations of numbers exist — minor units for money, scaled integers for rates
  and quantities — and every conversion between them is a named, tested operation.

## Alternatives considered

**PostgreSQL `numeric` for rates.** Exact in the database and, as ADR 0010 already argued
for money, still a string on arrival in JavaScript that must be parsed into a float or a
decimal library. The scaled integer is simpler and matches what `Quantity` does.

**Widening money to more minor units.** Storing every amount at scale 6 would let one type
carry both prices and rates. Rejected: it makes every stored amount ambiguous about
whether it has been rounded to a payable value, which is exactly the distinction that
matters when money is settled.

**Treating due dates as instants at midnight in the workspace timezone.** Works until the
workspace timezone changes or a report is run elsewhere, at which point dates shift by a
day and the error is invisible.
