import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import type { Money } from '../value-objects/financial-values'

abstract class FinancialEvent implements DomainEvent {
  abstract readonly eventType: string
  readonly eventVersion = 1
  constructor(
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    readonly occurredAt: Date,
  ) {}
  abstract payloadOf(): Readonly<Record<string, unknown>>
}

export const moneyPayload = (money: Money) => ({
  amount: money.amount.toString(),
  currency: money.currency.value,
})

/**
 * Titles publish per direction, so each type names what it is about. Only receivables
 * have published contracts so far; a payable event is added with its contract.
 */
export class TitlePostedEvent extends FinancialEvent {
  readonly eventType: string
  constructor(
    titleId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    direction: string,
    private readonly payload: Readonly<Record<string, unknown>>,
  ) {
    super(titleId, tenantId, occurredAt)
    this.eventType = `financial.${direction}.posted`
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return { titleId: this.aggregateId.toString(), ...this.payload }
  }
}

export class TitleReversedEvent extends FinancialEvent {
  readonly eventType: string
  constructor(
    titleId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    direction: string,
    private readonly payload: { partyId: string; reason: string },
  ) {
    super(titleId, tenantId, occurredAt)
    this.eventType = `financial.${direction}.reversed`
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      titleId: this.aggregateId.toString(),
      partyId: this.payload.partyId,
      reversedAt: this.occurredAt.toISOString(),
      reason: this.payload.reason,
    }
  }
}

export class SettlementRecordedEvent extends FinancialEvent {
  readonly eventType = 'financial.settlement.recorded'
  constructor(
    titleId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly payload: Readonly<Record<string, unknown>>,
  ) {
    super(titleId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      titleId: this.aggregateId.toString(),
      ...this.payload,
      recordedAt: this.occurredAt.toISOString(),
    }
  }
}

export class SettlementReversedEvent extends FinancialEvent {
  readonly eventType = 'financial.settlement.reversed'
  constructor(
    titleId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly payload: Readonly<Record<string, unknown>>,
  ) {
    super(titleId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      titleId: this.aggregateId.toString(),
      ...this.payload,
      reversedAt: this.occurredAt.toISOString(),
    }
  }
}
