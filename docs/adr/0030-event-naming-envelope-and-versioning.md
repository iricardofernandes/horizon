# 30. Event naming, envelope, and version policy

- Status: accepted
- Date: 2026-09-07

## Context

Events are the durable public interface between modules. Unlike an HTTP call, an event
has no caller to negotiate with: it is emitted, and any number of consumers — including
consumers written later — interpret it. A schema change therefore breaks things
invisibly and at a distance.

A versioning policy that nothing enforces is documentation, and documentation is not a
guarantee.

## Decision

**Naming:** `<module>.<aggregate>.<past-tense-verb>` — `sales.order.confirmed`,
`inventory.stock.reserved`. Past tense, because an event is a record of something that
happened, not a request for something to happen. A command named as an event is the
most common way event-driven systems turn back into RPC.

**Envelope**, identical for every event:

| Field | Purpose |
|---|---|
| `eventId` | UUIDv7; the inbox deduplication key (ADR 0024) |
| `eventType` | The name above |
| `eventVersion` | Integer, incremented only on a breaking change |
| `occurredAt` | UTC instant the fact became true (ADR 0011) |
| `tenantId` | Tenant context for the consumer (ADR 0017) |
| `traceId` | Ties the event into the originating trace (ADR 0033) |
| `payload` | The event-specific body |

**Change policy:**

- **Additive change** — a new optional field — bumps the package **minor** version. The
  `eventVersion` does not change; existing consumers are unaffected.
- **Breaking change** — removing a field, renaming one, narrowing a type, changing a
  meaning — publishes a **new `eventVersion`**, and **both versions are emitted during a
  documented deprecation window** so consumers migrate on their own schedule.
- **A published schema is never mutated in place.** Ever. It is the definition of the
  guarantee.

**Enforcement:** a CI job compares each schema against the last published version and
**fails on a breaking change without a major bump**. This is the load-bearing part of
the ADR; everything above it is a convention until the gate exists.

**`docs/events.md` is generated from the schemas**, so the catalogue cannot drift from
the code.

## Consequences

- A consumer written against `eventVersion: 1` keeps working when version 2 appears,
  until the deprecation window closes and version 1 stops being emitted.
- Dual emission means a producer temporarily maintains two serialisers for one fact.
  That cost is the price of independent deployment, and it is bounded by the window.
- `traceId` in the envelope, propagated through RabbitMQ headers, is what makes the
  golden path a single trace across three services (Phase 8).
- `tenantId` in the envelope means a consumer never has to infer tenancy from payload
  contents.
- The compatibility gate needs the previously published schemas available in CI, which
  it fetches from the registry (ADR 0029). This is a second reason the registry exists.
- Deprecation windows must actually be closed. An unclosed window means dual emission
  forever, so each one has a declared end date recorded in `docs/events.md`.

## Alternatives considered

**Version in the event name** (`sales.order.confirmed.v2`). Rejected: it fragments
routing keys, so every consumer binding must be updated for a version bump even when the
consumer does not care.

**No versioning; consumers tolerate anything.** Rejected: it pushes the entire
compatibility burden onto every consumer and makes a removed field a runtime surprise.

**Avro or Protobuf with a schema registry.** Stronger guarantees, real binary
compatibility checking, and a mature ecosystem. Rejected: Zod is already the validation
layer at the HTTP boundary, so a second schema language would mean two definitions of
the same shapes, and the compatibility gate implemented here provides the specific
guarantee that matters.
