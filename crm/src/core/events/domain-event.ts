import type { UniqueEntityID } from '../entities/unique-entity-id'

export interface DomainEvent {
  readonly eventType: string
  readonly eventVersion: number
  readonly occurredAt: Date
  readonly aggregateId: UniqueEntityID
  readonly tenantId: string
  payloadOf(): Readonly<Record<string, unknown>>
}
