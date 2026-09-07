# 24. Transactional outbox, and inbox idempotency

- Status: accepted
- Date: 2026-09-07

## Context

With one database per module (ADR 0016), a state change and its announcement live in
two different systems. The naive implementation is:

```
await db.transaction(...)      // commit the order
await rabbit.publish(event)    // tell everyone
```

Those are not atomic. A crash, a network partition or a broker hiccup between the two
lines commits the order and loses the event permanently, with no error anywhere and no
way to detect it afterwards. Inventory is never told to reserve stock; the order sits
confirmed and unfulfilled. Reversing the order — publish first, then commit — is worse:
now the event describes a state that may never exist.

This is not an edge case. It is the default behaviour of the obvious implementation,
and it is why the outbox is mandatory rather than an optimisation.

## Decision

**Transactional outbox.** An `outbox` table in each module's database. The domain
change and the outbox row are written **in the same transaction**. If the transaction
commits, the event exists; if it rolls back, neither exists. There is no third state.

A **relay** polls undispatched rows with `FOR UPDATE SKIP LOCKED`, publishes to
RabbitMQ, and marks them dispatched. `SKIP LOCKED` means multiple relay replicas can
run concurrently without coordination: each claims rows the others are not holding.

**At-least-once delivery is the consequence** — the relay can publish and then crash
before marking the row, so the event is republished. This is accepted rather than
fought, because exactly-once delivery does not exist over a network.

**Therefore, an inbox.** Every consuming module has an `inbox` table with a unique
constraint on `(source_module, event_id)`. The consumer inserts the inbox row **inside
the same transaction** as the effect it produces. A duplicate delivery violates the
constraint, the transaction rolls back, the message is acknowledged, and the effect
happened exactly once.

## Consequences

- No event is ever lost, and no event describes a state that does not exist.
- Publication is asynchronous, so there is a delay between commit and delivery equal to
  the relay's poll interval. This is a real latency cost, measured and exposed as an
  `outbox_lag` metric with the oldest undispatched row's age. It is one of the tools
  the MCP debugger exposes (ADR 0035).
- Consumers must be idempotent, which the inbox enforces mechanically rather than
  leaving to each consumer's care.
- Two extra tables and a background process per module, with their own retention: both
  tables are pruned on a schedule, the inbox's retention window set longer than the
  maximum possible redelivery window.
- Ordering is not guaranteed across aggregates. Where order matters it is enforced per
  aggregate by including a sequence number in the event and having the consumer reject
  out-of-order arrivals — not by assuming the broker preserves order.
- The relay is a background worker touching many tenants' rows; it sets tenant context
  per row, never per batch (ADR 0017).
- The domain-event pattern from the reference project is kept, but its **static
  in-process dispatcher is discarded** — see `docs/reference-analysis.md` §2.3.
  Aggregates accumulate events; the repository writes them to the outbox.

## Alternatives considered

**Publish directly after commit.** Rejected as described in Context.

**Two-phase commit between PostgreSQL and RabbitMQ.** Technically possible, and it
introduces a coordinator whose failure blocks both systems. Rejected.

**Change Data Capture (Debezium reading the WAL).** Genuinely excellent: no polling, no
relay, lower latency. Rejected as too much operational apparatus — Kafka Connect or an
equivalent, per database — for a system with five modules. The outbox table is
explicit, debuggable with a `SELECT`, and needs nothing beyond PostgreSQL.

**`LISTEN`/`NOTIFY` to wake the relay instead of polling.** A reasonable latency
optimisation over the same table, and compatible with this design. Deferred, not
rejected: it is added if the measured lag justifies it.
