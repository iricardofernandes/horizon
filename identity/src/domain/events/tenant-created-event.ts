import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'

/** Mirrors `identity.tenant.created` v1 in `@horizon/contracts`. */
export class TenantCreatedEvent implements DomainEvent {
  readonly eventType = 'identity.tenant.created'
  readonly eventVersion = 1

  constructor(
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    private readonly name: string,
    private readonly timezone: string,
    readonly occurredAt: Date,
  ) {}

  payloadOf(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      tenantId: this.tenantId,
      name: this.name,
      timezone: this.timezone,
      createdAt: this.occurredAt.toISOString(),
    })
  }
}
