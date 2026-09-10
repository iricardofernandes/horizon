import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'

/**
 * Mirrors `identity.data-subject.erased` v1.
 *
 * Every module holding personal data for this subject must shred its own copies. This is
 * the event that makes erasure a system-wide operation rather than one module's cleanup.
 */
export class DataSubjectErasedEvent implements DomainEvent {
  readonly eventType = 'identity.data-subject.erased'
  readonly eventVersion = 1

  constructor(
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    readonly occurredAt: Date,
  ) {}

  payloadOf(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      tenantId: this.tenantId,
      subjectId: this.aggregateId.toString(),
      erasedAt: this.occurredAt.toISOString(),
    })
  }
}
