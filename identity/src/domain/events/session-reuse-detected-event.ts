import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'

/**
 * Mirrors `identity.session.reuse-detected` v1.
 *
 * The family id, never a token — not even a hashed one. This is the one event in the
 * module that anything monitoring the system should alert on (ADR 0020).
 */
export class SessionReuseDetectedEvent implements DomainEvent {
  readonly eventType = 'identity.session.reuse-detected'
  readonly eventVersion = 1

  constructor(
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    private readonly userId: string,
    readonly occurredAt: Date,
  ) {}

  payloadOf(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      tenantId: this.tenantId,
      userId: this.userId,
      familyId: this.aggregateId.toString(),
      detectedAt: this.occurredAt.toISOString(),
    })
  }
}
