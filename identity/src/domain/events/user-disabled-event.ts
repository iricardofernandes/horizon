import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'

/** Mirrors `identity.user.disabled` v1. */
export class UserDisabledEvent implements DomainEvent {
  readonly eventType = 'identity.user.disabled'
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
      disabledAt: this.occurredAt.toISOString(),
    })
  }
}
