import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import type { Money } from '../value-objects/treasury-values'

export const moneyPayload = (money: Money) => ({
  amount: money.amount.toString(),
  currency: money.currency.value,
})

/** Every treasury event is one record: a type, its payload and the aggregate it concerns. */
export class TreasuryEvent implements DomainEvent {
  readonly eventVersion = 1
  constructor(
    readonly eventType: string,
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    readonly occurredAt: Date,
    private readonly payload: Readonly<Record<string, unknown>>,
  ) {}
  payloadOf(): Readonly<Record<string, unknown>> {
    return this.payload
  }
}
