# Event catalogue

<!--
  GENERATED — do not edit.
  Source: contracts/src/events/, via contracts/scripts/generate-events-doc.mjs.
  Regenerate with: cd contracts && npm run docs:events
  CI fails if this file differs from what the current schemas produce.
-->

Every event Horizon publishes, generated from `@horizon/contracts` **v0.12.0**.

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

## `catalog`

### `catalog.item.created` — v1

A product or service was added to a tenant catalog and may be referenced by downstream modules.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `itemId` | string | yes | Catalog item identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `kind` | `product` \| `service` | yes | — |
| `sku` | string | yes | min length 1. max length 64 |
| `name` | string | yes | min length 1. max length 160 |
| `unitId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `ncm` | any | yes | — |
### `catalog.item.deactivated` — v1

A catalog item can no longer be added to new business documents; historical references remain valid.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `itemId` | string | yes | Catalog item identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
### `catalog.price.changed` — v1

The current amount for an item in a price list changed; existing order snapshots remain unchanged.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `priceListId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `itemId` | string | yes | Catalog item identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `amount` | string | yes | pattern `^\d+$` |
| `currency` | string | yes | pattern `^[A-Z]{3}$`. min length 3. max length 3 |

## `financial`

### `financial.payable.posted` — v1

A payable left draft and became an obligation to a supplier, after the approval the workspace policy required. Installment amounts always add up to the total; corrections are reversals, never edits (ADR 0042).

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `titleId` | string | yes | Financial title identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `partyId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `documentNumber` | string | yes | min length 1. max length 40 |
| `origin` | any | yes | — |
| `categoryId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `issuedOn` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$`. format `date` |
| `competenceOn` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$`. format `date` |
| `total` | object | yes | — |
| `installments` | array | yes | — |
| `allocations` | array | yes | — |
| `postedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `financial.payable.reversed` — v1

A posted payable with no settlement in force was reversed. The title remains, marked reversed, with its reason.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `titleId` | string | yes | Financial title identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `partyId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `reversedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
| `reason` | string | yes | min length 3. max length 500 |
### `financial.receivable.posted` — v1

A receivable left draft and became an immutable claim on a customer. Installment amounts always add up to the total; from here corrections are reversals, never edits (ADR 0042).

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `titleId` | string | yes | Financial title identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `partyId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `documentNumber` | string | yes | min length 1. max length 40 |
| `origin` | any | yes | — |
| `categoryId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `issuedOn` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$`. format `date` |
| `competenceOn` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$`. format `date` |
| `total` | object | yes | — |
| `installments` | array | yes | — |
| `allocations` | array | yes | — |
| `postedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `financial.receivable.reversed` — v1

A posted receivable with no settlement in force was reversed. The title remains, marked reversed, so its history and the reason stay readable.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `titleId` | string | yes | Financial title identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `partyId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `reversedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
| `reason` | string | yes | min length 3. max length 500 |
### `financial.settlement.recorded` — v1

Money was received or paid against one installment. `received` is the cash that moved; `discount` reduces what is owed without cash; `interest` and `penalty` add to it. `outstanding` is the title balance after this settlement. With `treasuryAccountId`, Treasury records `received` in that account. `documentNumber` names the title settled, so a consumer never has to hold the title to label the movement.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `settlementId` | string | yes | Settlement identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `titleId` | string | yes | Financial title identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `direction` | `receivable` \| `payable` | yes | — |
| `partyId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `documentNumber` | string | no | min length 1. max length 40 |
| `installmentNumber` | integer | yes | — |
| `settledOn` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$`. format `date` |
| `received` | object | yes | — |
| `discount` | object | yes | — |
| `interest` | object | yes | — |
| `penalty` | object | yes | — |
| `paymentMethodId` | any | yes | — |
| `treasuryAccountId` | string | no | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `outstanding` | object | yes | — |
| `recordedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `financial.settlement.reversed` — v1

A recorded settlement was undone — a bounced payment, a wrong installment. The settlement stays in history, marked reversed; `outstanding` is the title balance restored.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `settlementId` | string | yes | Settlement identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `titleId` | string | yes | Financial title identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `direction` | `receivable` \| `payable` | yes | — |
| `partyId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `reversedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
| `reason` | string | yes | min length 3. max length 500 |
| `outstanding` | object | yes | — |

## `identity`

### `identity.api-key.revoked` — v1

An API key is no longer valid. Carries the public prefix rather than the key, so a consumer can invalidate a cache entry and an operator can match a log line, and neither ever handles the secret.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `tenantId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `apiKeyId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `prefix` | string | yes | min length 24. max length 24 |
| `revokedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `identity.data-subject.erased` — v1

A data-subject key was destroyed (ADR 0026). Every module holding personal data for this subject must shred its own copies; the ciphertext identity holds is now unrecoverable by anyone, including the operator.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `tenantId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `subjectId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `erasedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `identity.session.reuse-detected` — v1

A rotated refresh token was replayed, which means two parties hold tokens from one family. The family was destroyed, logging out both. Security-relevant: consumers that alert on anything should alert on this.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `tenantId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `userId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `familyId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `detectedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `identity.tenant.created` — v1

A tenant now exists. Consumers may create tenant-scoped defaults — catalog creates the default unit-of-measure set and an empty base price list.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `tenantId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `name` | string | yes | min length 1. max length 200 |
| `timezone` | string | yes | IANA timezone, e.g. America/Sao_Paulo. min length 1 |
| `createdAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `identity.user.disabled` — v1

Access was revoked. Every consumer holding cached authorization state for this user must drop it; sessions and API keys issued by the user are already dead at the source.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `tenantId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `userId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `disabledAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `identity.user.registered` — v1

A user was created within a tenant. Consumers may create per-user defaults; none may assume the user can do anything yet, because roles are assigned separately.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `tenantId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `userId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `registeredAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |

## `inventory`

### `inventory.stock.moved` — v1

An append-only movement changed on-hand stock and records the resulting balance and cost.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `movementId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `itemId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `warehouseId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `kind` | `receipt` \| `shipment` \| `adjustment-in` \| `adjustment-out` | yes | — |
| `balanceVersion` | integer | yes | — |
| `quantity` | string | yes | pattern `^\d+(\.\d{1,6})?$` |
| `balanceAfter` | string | yes | pattern `^\d+(\.\d{1,6})?$` |
| `unitCost` | any | yes | — |
### `inventory.stock.released` — v1

A reservation stopped holding stock because its order was cancelled or it expired.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `orderId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `orderVersion` | integer | yes | — |
| `reservationId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `reason` | `cancelled` \| `expired` | yes | — |
| `releasedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `inventory.stock.reservation-rejected` — v1

A sales order could not be reserved atomically; no line was held and every shortfall is reported.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `orderId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `orderVersion` | integer | yes | — |
| `shortfalls` | array | yes | — |
### `inventory.stock.reserved` — v1

Every line of a placed sales order was held atomically until confirmation or expiry.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `orderId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `orderVersion` | integer | yes | — |
| `reservationId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `expiresAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
| `lines` | array | yes | — |

## `ledger`

### `ledger.account.opened` — v1

An account was added to the chart of accounts. Only a leaf account is `postable`; a parent exists to total its children and never takes a line of its own.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `accountId` | string | yes | Ledger account identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `code` | string | yes | pattern `^\d{1,3}(?:\.\d{1,3}){0,4}$` |
| `name` | string | yes | min length 2. max length 120 |
| `type` | `asset` \| `liability` \| `equity` \| `revenue` \| `expense` | yes | — |
| `parentId` | any | yes | — |
| `postable` | boolean | yes | — |
| `currency` | string | yes | pattern `^[A-Z]{3}$` |
| `openedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `ledger.period.closed` — v1

A calendar month was closed. Nothing may be posted into it, or reversed inside it, until it is reopened with a reason.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `periodId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `period` | string | yes | pattern `^\d{4}-(?:0[1-9]|1[0-2])$` |
| `closedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `ledger.period.reopened` — v1

A closed month was reopened so it can take postings again. The reason is kept, because reopening a closed period is an accounting event in its own right.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `periodId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `period` | string | yes | pattern `^\d{4}-(?:0[1-9]|1[0-2])$` |
| `reopenedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
| `reason` | string | yes | min length 3. max length 500 |
### `ledger.transaction.posted` — v1

A balanced journal transaction was posted. Its debits equal its credits, every line is in the transaction currency, and `postedOn` falls in an open period. A posted transaction is never edited: a correction is a reversal plus a new transaction (ADR 0042).

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `transactionId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `reference` | string | yes | min length 1. max length 60 |
| `postedOn` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$`. format `date` |
| `period` | string | yes | pattern `^\d{4}-(?:0[1-9]|1[0-2])$` |
| `total` | object | yes | — |
| `source` | object | yes | — |
| `lines` | array | yes | — |
| `postedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `ledger.transaction.reversed` — v1

A posted transaction was undone by a mirror transaction with every side swapped. Both stay in the journal, and the reversal cannot itself be reversed.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `transactionId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `reversalId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `reversedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
| `reason` | string | yes | min length 3. max length 500 |

## `parties`

### `parties.party.erased` — v1

The party’s personal data was crypto-shredded. Every projection must destroy its own copy; the payload carries no personal data by construction.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `partyId` | string | yes | Party identifier, shared by every context that projects it. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
### `parties.party.registered` — v1

An organization or person entered the shared registry with the roles it plays. Consumers build their own projection keyed by the party id; the tax identifier is deliberately absent.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `partyId` | string | yes | Party identifier, shared by every context that projects it. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `kind` | `organization` \| `person` | yes | — |
| `legalName` | string | yes | min length 2. max length 160 |
| `tradeName` | any | yes | — |
| `email` | string | yes | pattern `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`. format `email`. max length 254 |
| `phone` | string | yes | pattern `^\+?\d{8,15}$` |
| `address` | string | yes | min length 5. max length 500 |
| `roles` | array | yes | — |
### `parties.party.role-granted` — v1

A party started playing a role — a supplier became a customer too. `roles` is the complete set after the change; a `parties.party.updated` carrying the party’s details follows in the same transaction.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `partyId` | string | yes | Party identifier, shared by every context that projects it. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `role` | `customer` \| `supplier` \| `carrier` \| `prospect` \| `partner` | yes | — |
| `roles` | array | yes | — |
### `parties.party.role-revoked` — v1

A party stopped playing a role. The party remains, and documents that already reference it keep that reference.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `partyId` | string | yes | Party identifier, shared by every context that projects it. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `role` | `customer` \| `supplier` \| `carrier` \| `prospect` \| `partner` | yes | — |
| `roles` | array | yes | — |
### `parties.party.updated` — v1

A party’s identifying details, roles or active state changed. Consumers replace their projected copy; posted documents keep the snapshot they took.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `partyId` | string | yes | Party identifier, shared by every context that projects it. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `legalName` | string | yes | min length 2. max length 160 |
| `tradeName` | any | yes | — |
| `email` | string | yes | pattern `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`. format `email`. max length 254 |
| `phone` | string | yes | pattern `^\+?\d{8,15}$` |
| `address` | string | yes | min length 5. max length 500 |
| `roles` | array | yes | — |
| `active` | boolean | yes | — |

## `sales`

### `sales.invoicing.requested` — v1

A confirmed order is ready for the future Fiscal module to issue its invoice document.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `orderId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `orderVersion` | integer | yes | — |
| `customerId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `confirmedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
| `lines` | array | yes | — |
| `total` | object | yes | — |
### `sales.order.cancelled` — v1

A sales order will not proceed; Inventory may release its reservation when one exists.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `orderId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `orderVersion` | integer | yes | — |
| `reservationId` | any | yes | — |
| `cancelledAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
| `reason` | any | yes | — |
### `sales.order.confirmed` — v1

Inventory reserved every line and Sales committed the immutable commercial snapshot.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `orderId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `orderVersion` | integer | yes | — |
| `customerId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `reservationId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `confirmedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
| `lines` | array | yes | — |
| `total` | object | yes | — |
### `sales.order.placed` — v1

A sales order was submitted for atomic stock reservation at its fulfillment warehouse.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `orderId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `orderVersion` | integer | yes | — |
| `customerId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `fulfillmentWarehouseId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `lines` | array | yes | — |

## `treasury`

### `treasury.account.opened` — v1

A bank, cash, card-clearing or virtual account started keeping a journal. Its opening balance arrives as the first `treasury.entry.recorded`.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `accountId` | string | yes | Treasury account identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `kind` | `bank` \| `cash` \| `card-clearing` \| `virtual` | yes | — |
| `name` | string | yes | min length 2. max length 120 |
| `currency` | string | yes | pattern `^[A-Z]{3}$` |
| `openedOn` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$`. format `date` |
### `treasury.entry.recorded` — v1

One line was appended to an account journal. Amounts are never negative: `direction` says whether money came in or went out. A correction is a new entry naming the one it `reverses`; nothing is edited or deleted (ADR 0042).

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `entryId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `accountId` | string | yes | Treasury account identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `direction` | `inflow` \| `outflow` | yes | — |
| `amount` | object | yes | — |
| `valueOn` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$`. format `date` |
| `source` | object | yes | — |
| `reverses` | any | yes | — |
| `recordedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `treasury.reconciliation.confirmed` — v1

A person confirmed that statement lines and journal entries describe the same movements, or that statement lines are to be ignored. A suggestion never confirms itself (ADR 0046).

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `reconciliationId` | string | yes | Reconciliation identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `accountId` | string | yes | Treasury account identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `kind` | `match` \| `ignore` | yes | — |
| `origin` | `manual` \| `suggestion` | yes | — |
| `statementLineIds` | array | yes | — |
| `entryIds` | array | yes | — |
| `amount` | object | yes | — |
| `confirmedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `treasury.reconciliation.undone` — v1

A confirmed reconciliation was undone. The statement lines and entries become unmatched again; the reconciliation stays in history.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `reconciliationId` | string | yes | Reconciliation identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `accountId` | string | yes | Treasury account identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `undoneAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
| `reason` | string | yes | min length 3. max length 500 |
### `treasury.statement.imported` — v1

A bank statement file was imported into an account. Statement lines are immutable; `duplicateCount` lines were already known from an earlier import and were not stored again (ADR 0046).

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `importId` | string | yes | pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `accountId` | string | yes | Treasury account identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `format` | `ofx` \| `csv` | yes | — |
| `lineCount` | integer | yes | — |
| `duplicateCount` | integer | yes | — |
| `periodStart` | any | yes | — |
| `periodEnd` | any | yes | — |
| `importedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
### `treasury.transfer.cancelled` — v1

A posted transfer was undone by inverse entries on both accounts. The original legs stay in the journal.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `transferId` | string | yes | Internal transfer identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `cancelledAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
| `reason` | string | yes | min length 3. max length 500 |
### `treasury.transfer.posted` — v1

Money moved between two accounts of the same workspace and currency. Both legs, and the fee when there is one, were committed in the same transaction as this event.

**Payload**

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `transferId` | string | yes | Internal transfer identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `fromAccountId` | string | yes | Treasury account identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `toAccountId` | string | yes | Treasury account identifier. pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`. format `uuid` |
| `amount` | object | yes | — |
| `fee` | any | yes | — |
| `valueOn` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$`. format `date` |
| `postedAt` | string | yes | pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`. format `date-time` |
