# Event catalogue

<!--
  GENERATED — do not edit.
  Source: contracts/src/events/, via contracts/scripts/generate-events-doc.mjs.
  Regenerate with: cd contracts && npm run docs:events
  CI fails if this file differs from what the current schemas produce.
-->

Every event Horizon publishes, generated from `@horizon/contracts` **v0.1.0**.

Events are the durable public interface between modules. Unlike an HTTP call there is no
caller to negotiate with — an event is emitted, and any number of consumers, including
ones written later, interpret it.

## Delivery guarantees

Every event is written to the publishing module's `outbox` table **inside the same
transaction** as the state change it describes, and relayed by a poller using
`FOR UPDATE SKIP LOCKED`. If the transaction commits the event exists; if it rolls back
neither exists. There is no third state.

The relay can publish and then crash before marking the row, so delivery is
**at-least-once**. Every consumer therefore writes an `inbox` row unique on
`(source_module, event_id)` inside the same transaction as the effect, which makes
processing exactly-once. Deduplicate on `eventId`.

Ordering is **not** guaranteed across aggregates. Where it matters the payload carries a
per-aggregate sequence number and the consumer rejects out-of-order arrivals.

## Versioning

| Change | Package version | `eventVersion` |
|---|---|---|
| New optional field | minor | unchanged |
| New event type | minor | n/a |
| Removed or renamed field, narrowed type, changed meaning | major | **new version** |

A published schema is **never** mutated in place. A breaking change publishes a new
`eventVersion`, and the producer emits both during a documented deprecation window.
`scripts/check-contract-compat.mjs` fails the build on a breaking change that is not
accompanied by a major bump.

## Envelope

Identical for every event.

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `eventId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `eventType` | string | yes | min length 1 |
| `eventVersion` | integer | yes | — |
| `occurredAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
| `tenantId` | string | yes | The tenant every row is scoped by. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `traceId` | string | yes | pattern `^[0-9a-f]{32}$` |
| `payload` | any | yes | — |

## `identity`

### `identity.tenant.created` — v1

A tenant now exists. Consumers may create tenant-scoped defaults — catalog creates the default unit-of-measure set and an empty base price list.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `tenantId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `name` | string | yes | min length 1. max length 200 |
| `timezone` | string | yes | IANA timezone, e.g. America/Sao_Paulo. min length 1 |
| `createdAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
