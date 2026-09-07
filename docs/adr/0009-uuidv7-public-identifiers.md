# 9. UUIDv7 for all public identifiers

- Status: accepted
- Date: 2026-09-07

## Context

Identifiers in Horizon are public: they appear in URLs, in event payloads, in webhook
bodies and in API responses. They are also primary keys in five independent
databases, and they must be generatable before a row is written — an aggregate has an
identity from the moment it is constructed, and an outbox row references it inside
the same transaction.

Two properties are in tension. Sequential integers give perfect index locality and
leak business volume, enumerate trivially, and collide across independently-seeded
databases. Random UUIDs (v4) leak nothing and never collide, but insert at random
positions in a B-tree, fragmenting pages and inflating write amplification as tables
grow.

## Decision

**UUIDv7** for every public identifier, generated **in the application layer** and
stored in a PostgreSQL `uuid` column. Never `bigserial`.

UUIDv7 encodes a millisecond Unix timestamp in its high bits followed by random bits,
so values generated over time are monotonically increasing. Inserts land at the right
edge of the index, as a sequence would, while remaining globally unique and
non-enumerable.

"Application layer" here means "in Node, not by a database default" — the value is
produced when the entity is constructed, which is in `domain/`. The distinction that
matters is that the database never assigns identity, because the aggregate needs its
id before the transaction opens.

## Consequences

- Index locality close to a sequence, with none of the coordination or enumeration
  problems.
- An id reveals its creation time to the millisecond. This is acceptable for ERP
  records — creation time is generally visible in the payload anyway — but it means a
  UUIDv7 must never be used where unlinkability matters. Refresh tokens and API key
  secrets are therefore **not** UUIDs at all; they are high-entropy random strings
  (ADRs 0020, 0022).
- Ids sort chronologically, which makes keyset pagination on `(tenant_id, id)` viable
  without a separate timestamp column.
- Storage is 16 bytes rather than 8. Accepted.
- Requires a library; Node has no native UUIDv7 generator. A single small dependency,
  wrapped by `UniqueEntityID` so the choice is replaceable in one file per module.

## Alternatives considered

**UUIDv4.** The common default. Rejected on index fragmentation; the cost is
invisible at a thousand rows and material at ten million.

**`bigserial`.** Rejected: enumerable, leaks volume, and collides across the five
independent databases the moment an id crosses a module boundary in an event.

**ULID.** Same time-ordering property, and lexicographically sortable as text.
Rejected: it is not a `uuid` type in PostgreSQL, so it stores as `text` or `bytea` and
loses native indexing and formatting; UUIDv7 gets the same benefit inside the standard
type.

**Snowflake-style ids.** Requires node-id coordination. Rejected as unnecessary
infrastructure.
