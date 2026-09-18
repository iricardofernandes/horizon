import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import type { Money, Quantity } from '../value-objects/procurement-values'

export const moneyPayload = (money: Money) => ({
  amount: money.amount.toString(),
  currency: money.currency.value,
})

export const quantityPayload = (quantity: Quantity) => quantity.toString()

/** Every procurement event is one record: a type, its payload and the aggregate it concerns. */
export class ProcurementEvent implements DomainEvent {
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
