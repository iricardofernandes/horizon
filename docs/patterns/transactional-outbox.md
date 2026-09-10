# Transactional outbox

Source: `identity/src/infrastructure/database/drizzle/identity-database.ts`,
`schema/messaging.ts`, and `identity/src/infrastructure/messaging/`. Proof:
`identity/test/outbox.e2e-spec.ts`.

Record state and events in one tenant transaction. Repositories drain domain events
when saving the aggregate. Events belonging to Redis aggregates are handed to the
outbox port explicitly. Reject an event whose tenant differs from the transaction.
Validate wire bodies against the exact pinned `@horizon/contracts` version before
publication. Preserve eventId on every retry and persist trace context across the
asynchronous boundary.

A separate relay role may select and update only outbox rows. A relay claims a bounded
batch with `FOR UPDATE SKIP LOCKED`, holds those locks through publisher confirmation,
and marks successful rows dispatched. Concurrent replicas can work on different rows.
RabbitMQ publications are persistent and mandatory: an unroutable message must remain
pending even if the exchange confirms it. Provision durable subscriber queues before
expecting delivery to finish.

A crash after broker confirmation and before database commit can duplicate delivery.
Never call this exactly once; consumers need an inbox. Failure bookkeeping commits
while the failed row stays pending. The worker retries with bounded exponential jitter,
has one flush in flight, and drains that flush during shutdown. Monitor
`outbox_lag_seconds`, `outbox_published_total` and `outbox_publish_failures_total`.

For another module, change source event definitions, credentials and routing keys.
Retain the two-relay, failed-publish and unbound-queue integration tests. Queue backlog
must trigger operational alerts; Identity currently retains pending rows rather than
silently discarding them or shedding business writes.
