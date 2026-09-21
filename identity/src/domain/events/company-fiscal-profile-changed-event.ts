import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'

/** A notice only. The profile is fetched by a restricted projector, never put on the bus. */
export class CompanyFiscalProfileChangedEvent implements DomainEvent {
  readonly eventType = 'identity.company.fiscal-profile-changed'
  readonly eventVersion = 1

  constructor(
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    private readonly revision: number,
    private readonly effectiveFrom: string,
    readonly occurredAt: Date,
  ) {}

  payloadOf(): Readonly<Record<string, unknown>> {
    return { tenantId: this.tenantId, revision: this.revision, effectiveFrom: this.effectiveFrom }
  }
}
