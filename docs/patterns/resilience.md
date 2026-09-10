# Bounded dependency work

Source: `identity/src/infrastructure/database/drizzle/identity-database.ts`,
`identity/src/infrastructure/cache/`, `identity/src/infrastructure/messaging/`, and
`identity/src/main/identity-runtime.ts`. Proof: database, Redis outage and broker e2e tests.

Every database pool has a maximum and connection/statement timeouts. Redis disables
the offline queue for authentication-sensitive operations, bounds command time and
fails session extension closed. Denylist outage is a three-state result; only routes
explicitly marked as nonprivileged reads may proceed. Administrative reads and all
writes fail closed. Expose this distinction in route metadata and OpenAPI.

Outbox delivery has a separate one-connection pool and bounded batch, so a stalled
broker cannot consume the application's SQL pool. Publisher confirmation is bounded.
The worker never overlaps its own flush, retries a retained batch with exponential
backoff and jitter, and waits for in-flight work during shutdown. Lag, publication
and failure metrics expose the delivery backlog. An unroutable publication is a
failure, not a successful empty delivery.

Identity currently has no cross-module HTTP call and no business AMQP consumer.
Circuit breakers and consumer prefetch must be implemented at the first such call
or consumer; do not pretend an unused configuration variable is a tested breaker.
Follow ADR 0027: finite timeout, closed/open/half-open state, bounded probes, failure
and state metrics, and retries only for idempotent operations. HTTP writes need an
idempotency key before retrying.

For another module, set timeouts from measured latency, configure independent pools
per dependency class and define backlog alert thresholds. Test stopped dependencies
and recovery, not just rejected promises. Consumer queues require durable topology,
bounded prefetch and an explicit dead-letter/retention policy before production use.
