# 77. The business day is told where the business is

- Status: accepted. Implemented in Phase 92 ([plan](../security-logic-plan.md)).
- Date: 2026-10-03

## Context

Every module took "today" from the UTC date of the server's clock. Brasília is three hours
behind UTC, so between 21:00 and midnight there:
- a title due today was already overdue;
- a lot expiring today had already expired;
- a report "as of today", an order's issue date and a service's competence default belonged
  to tomorrow, and on a month's last evening to the next month.

Fiscal already had the right idea in one place, where an import's day was computed by
subtracting three hours by hand.

## Decision

1. **A day is derived from an instant by one rule:** `businessDayOf(instant, timeZone)` in
   `@horizon/contracts`, which every module already depends on. A domain layer may not
   import the contracts, so the four value objects that need the rule keep a copy of it
   beside them, with the same default.
2. **The timezone is `America/Sao_Paulo` until a workspace states its own.** The function
   takes the timezone, so a workspace's own is a parameter away.
3. **Calendar arithmetic stays in UTC.** Adding days or months to a date, or naming a
   month's first day, builds a date at UTC midnight and reads it back unchanged. Only the
   step from an instant to a day uses the timezone.

## Consequences

- Overdue titles, lot expiry, default dates and as-of defaults agree with the calendar on
  the wall of a Brazilian business, at any hour.
- A workspace elsewhere is still told the day in Brasília. Carrying each workspace's
  timezone from Identity to every module, as the plan first described, is left for when a
  second timezone is needed.
- A stored date never changes: only which day "now" is.

## Alternatives considered

- **Carry each workspace's timezone to every module now,** through
  `identity.tenant.created` and a republish. Deferred: every workspace today is Brazilian,
  and one function with a default fixes the defect for all of them without a new
  projection in ten modules.
- **Have the browser always send the date.** Rejected: jobs, consumers and API callers
  have no browser, and a date the client chooses is not a clock.
