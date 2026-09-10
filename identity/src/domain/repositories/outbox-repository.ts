import type { DomainEvent } from '@/core/events/domain-event'

/**
 * The transactional outbox (ADR 0024).
 *
 * Most events never come through here: a repository drains its aggregate with
 * `pullDomainEvents()` and writes them as part of the same `save()`, so the state change
 * and its announcement are one transaction and there is no third state where one exists
 * without the other.
 *
 * This port exists for the aggregates that do **not** live in PostgreSQL. A refresh-token
 * family lives in Redis (ADR 0020), so `session.reuse-detected` has no repository write
 * to ride along with and has to be handed to the outbox explicitly.
 */
export abstract class OutboxRepository {
  abstract publish(events: readonly DomainEvent[]): Promise<void>
}
