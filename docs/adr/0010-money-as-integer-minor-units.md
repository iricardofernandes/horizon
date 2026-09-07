# 10. Money as integer minor units with an explicit currency

- Status: accepted
- Date: 2026-09-07

## Context

This is an ERP. Money appears in prices, order lines, discounts, tax bases, stock
valuation and payments. IEEE-754 binary floating point cannot represent `0.1`
exactly, so `0.1 + 0.2 !== 0.3`, and errors accumulate across the multiply-and-sum
operations that an order total is made of. A financial system that stores amounts as
`double precision` is wrong; it is only a question of how many rows it takes to
notice.

A second failure is subtler: an amount without a currency is not a quantity of money,
and once two currencies meet in the same column, every arithmetic operation is a
potential silent error.

## Decision

Money is stored as an **integer count of minor units in a `bigint` column**,
accompanied by an **explicit currency column**, and is manipulated only through a
`Money` value object.

`Money` is immutable, validates in its constructor, and refuses to add, subtract or
compare amounts of different currencies — that is a domain error, not a coercion.
Multiplication by a scalar is permitted with an explicit, named rounding mode;
division is only available as an allocation operation that distributes a total across
parts without losing or inventing a minor unit.

The number of minor units per major unit is a property of the currency, not a global
constant. It is not assumed to be 100.

## Consequences

- No floating point anywhere in a monetary path, from HTTP body to database column.
- `bigint` in PostgreSQL maps to `bigint` in JavaScript, not `number`. This is why the
  reference project's `ValueObject.equals()` implementation via `JSON.stringify` was
  rejected — `JSON.stringify` throws on `bigint` (see `docs/reference-analysis.md`
  §3.4).
- Serialisation must be explicit: `bigint` has no JSON representation. Money crosses
  the wire as `{ amount: "123456", currency: "BRL" }` with the amount as a string, and
  the Zod schemas in `@horizon/contracts` encode that shape once for the whole system.
- Rounding becomes a decision the caller must make and name, which is the correct
  amount of friction. Tax and discount rounding rules differ, and a silent default
  would hide that.
- Allocation prevents the classic bug where splitting 10.00 three ways yields 9.99.

## Alternatives considered

**PostgreSQL `numeric`.** Exact decimal arithmetic in the database, and a perfectly
respectable choice. Rejected because the arithmetic still happens in JavaScript, where
`numeric` arrives as a string and must be parsed into *something* — and that something
would be either a float (defeating the purpose) or a decimal library, at which point
the integer representation is simpler and faster with no loss.

**A decimal library (`decimal.js`, `big.js`) as the storage type.** Rejected: it
solves arithmetic but not the currency-pairing problem, and it invites storing the
decimal as text.

**Floating point with careful rounding.** Rejected. There is no careful enough.
