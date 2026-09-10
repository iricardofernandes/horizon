import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'

/**
 * Mirrors `identity.user.registered` v1.
 *
 * No email, no name. An event is durable and replayable, so personal data placed in one
 * is personal data that destroying a subject key cannot reach (ADR 0026).
 */
export class UserRegisteredEvent implements DomainEvent {
  readonly eventType = 'identity.user.registered'
  readonly eventVersion = 1

  constructor(
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    readonly occurredAt: Date,
  ) {}

  payloadOf(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      tenantId: this.tenantId,
      userId: this.aggregateId.toString(),
      registeredAt: this.occurredAt.toISOString(),
    })
  }
}
