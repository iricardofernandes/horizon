# `webhooks/`

Developer-facing subscriptions, HMAC-signed delivery, bounded retry, dead-letter and
replay. This is an independently deployable NestJS service with its own PostgreSQL
database and lifecycle.

**Status: phase 9 complete.** The domain, persistence, RabbitMQ consumer, delivery worker,
authenticated HTTP surface and end-to-end tests are implemented. See
[`docs/plan.md`](../docs/plan.md).

## Ownership and guarantees

The module owns subscriptions, encrypted signing secrets, the durable delivery queue and
append-only attempt history. It consumes versioned contracts from `@horizon/contracts`;
currently only `sales.order.confirmed` is bound. It does not own source events or identity.

Delivery is at least once. Receivers must deduplicate on `X-Horizon-Event-Id`. A malformed
or unsupported broker message is retried once and then routed to the RabbitMQ consumer
DLQ. A callback that exhausts its configured attempts enters the database-backed
`dead-letter` state and remains available for operator replay.

All business rows carry `tenant_id` and use forced PostgreSQL RLS. API calls derive the
tenant exclusively from a locally verified Identity access token. `viewer` can read;
`admin` can read, manage subscriptions and replay work.

## HTTP API

Paths are service-relative and are intended to be reached through Kong.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health/live` | Process liveness. |
| `GET` | `/health/ready` | Database-backed readiness. |
| `GET` | `/webhook-subscriptions` | List the tenant's subscriptions without secrets. |
| `POST` | `/webhook-subscriptions` | Create a subscription; returns its secret once. |
| `DELETE` | `/webhook-subscriptions/:id` | Deactivate a subscription. |
| `GET` | `/webhook-deliveries` | List recent delivery state and last outcome. |
| `GET` | `/webhook-deliveries/:id/attempts` | Read the append-only attempt log. |
| `POST` | `/webhook-deliveries/:id/replay` | Reset a dead letter for delivery. |

Creation accepts:

```json
{
  "endpointUrl": "https://integrator.example/horizon",
  "eventTypes": ["sales.order.confirmed"]
}
```

Plain HTTP is rejected except for loopback development endpoints. Userinfo in endpoint
URLs is rejected. Subscription secrets are random 32-byte values and are encrypted with
AES-256-GCM before storage.

## Signature verification

Each request contains the exact event envelope as JSON plus:

- `X-Horizon-Event-Id`: stable idempotency key;
- `X-Horizon-Signature`: `t=<unix-seconds>,v1=<lowercase-hex-hmac>`.

The signed bytes are `timestamp + "." + rawRequestBody`. Do not parse and reserialize the
body before verification. Reject timestamps outside your allowed skew and compare the
digest in constant time. A minimal Node.js verifier is:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verify(secret, rawBody, signature, now = Math.floor(Date.now() / 1000)) {
  const fields = Object.fromEntries(signature.split(',').map((part) => part.trim().split('=', 2)))
  const timestamp = Number(fields.t)
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest()
  const actual = Buffer.from(fields.v1 ?? '', 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
```

Return any `2xx` response to acknowledge delivery. Redirects are not followed. Other
statuses, network errors and timeouts are failures.

## Retry and backpressure policy

Failed attempts use exponential backoff capped by `WEBHOOK_BACKOFF_MAX_MS`, with bounded
jitter and at most `WEBHOOK_MAX_ATTEMPTS`. Each attempt records its number, timestamp,
duration, response status and bounded error text in an append-only table. Replay is only
valid from `dead-letter` and resets the attempt counter without deleting history.

Backpressure never silently drops a valid event. The RabbitMQ consumer is bounded by
`AMQP_PREFETCH`; once accepted, delivery work is durable in PostgreSQL. Each worker poll
claims at most `OUTBOX_BATCH_SIZE` due rows using `FOR UPDATE SKIP LOCKED`. When pending
plus delivering rows exceed `WEBHOOK_QUEUE_DEPTH_ALERT`, the worker emits the explicit
`webhook.queue-depth-exceeded` error signal and continues draining bounded batches. The
E2E suite forces the threshold crossing and asserts this behavior.

## Local development

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
npm start
```

The E2E suite starts isolated PostgreSQL 17 and RabbitMQ 4 containers. `make demo` at the
repository root proves the real Sales → Inventory → Webhooks path and a signed callback.

Important runtime controls are documented inline in [`.env.example`](.env.example):
database application/worker URLs, the 32-byte hex encryption key, JWKS URL, AMQP prefetch,
delivery timeout, retry/backoff values, claim batch, poll interval and queue-depth alert.
