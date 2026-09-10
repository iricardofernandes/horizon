import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'

/** Mirrors `identity.api-key.revoked` v1. Carries the public prefix, never the secret. */
export class ApiKeyRevokedEvent implements DomainEvent {
  readonly eventType = 'identity.api-key.revoked'
  readonly eventVersion = 1

  constructor(
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    private readonly prefix: string,
    readonly occurredAt: Date,
  ) {}

  payloadOf(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      tenantId: this.tenantId,
      apiKeyId: this.aggregateId.toString(),
      prefix: this.prefix,
      revokedAt: this.occurredAt.toISOString(),
    })
  }
}
