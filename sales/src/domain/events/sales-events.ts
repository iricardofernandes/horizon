import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import type { BusinessDate, LineDescription, Money, Quantity } from '../value-objects/sales-values'

abstract class SalesEvent implements DomainEvent {
  abstract readonly eventType: string
  readonly eventVersion = 1
  constructor(
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    readonly occurredAt: Date,
  ) {}
  abstract payloadOf(): Readonly<Record<string, unknown>>
}

export interface RequestedOrderLine {
  readonly lineId: string
  readonly itemId: string
  readonly quantity: Quantity
}

export interface ConfirmedOrderLine extends RequestedOrderLine {
  readonly description: LineDescription
  readonly unitPrice: Money
  readonly lineTotal: Money
}

/** One agreed payment of the order: when it falls due and how much of the total it is. */
export interface AgreedInstallment {
  readonly number: number
  readonly dueOn: BusinessDate
  readonly amount: Money
}

const moneyPayload = (money: Money) => ({
  amount: money.amount.toString(),
  currency: money.currency.value,
})

const installmentPayload = (installment: AgreedInstallment) => ({
  number: installment.number,
  dueOn: installment.dueOn.value,
  amount: moneyPayload(installment.amount),
})

const confirmedLinePayload = (line: ConfirmedOrderLine) => ({
  lineId: line.lineId,
  itemId: line.itemId,
  quantity: line.quantity.toString(),
  description: line.description.value,
  unitPrice: { amount: line.unitPrice.amount.toString(), currency: line.unitPrice.currency.value },
  lineTotal: { amount: line.lineTotal.amount.toString(), currency: line.lineTotal.currency.value },
})

export class SalesOrderPlacedEvent extends SalesEvent {
  readonly eventType = 'sales.order.placed'
  constructor(
    orderId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly order: {
      orderVersion: number
      customerId: string
      fulfillmentWarehouseId: string
      lines: readonly RequestedOrderLine[]
    },
  ) {
    super(orderId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      orderId: this.aggregateId.toString(),
      orderVersion: this.order.orderVersion,
      customerId: this.order.customerId,
      fulfillmentWarehouseId: this.order.fulfillmentWarehouseId,
      lines: this.order.lines.map((line) => ({ ...line, quantity: line.quantity.toString() })),
    }
  }
}

export class SalesOrderConfirmedEvent extends SalesEvent {
  readonly eventType = 'sales.order.confirmed'
  constructor(
    orderId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly order: {
      orderVersion: number
      customerId: string
      reservationId: string
      lines: readonly ConfirmedOrderLine[]
      total: Money
      installments: readonly AgreedInstallment[]
    },
  ) {
    super(orderId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      orderId: this.aggregateId.toString(),
      orderVersion: this.order.orderVersion,
      customerId: this.order.customerId,
      reservationId: this.order.reservationId,
      confirmedAt: this.occurredAt.toISOString(),
      lines: this.order.lines.map(confirmedLinePayload),
      total: {
        amount: this.order.total.amount.toString(),
        currency: this.order.total.currency.value,
      },
      // What the customer agreed to pay and when, so Financial raises the receivable on
      // the schedule rather than on one instalment it invented.
      installments: this.order.installments.map(installmentPayload),
    }
  }
}

export class SalesInvoicingRequestedEvent extends SalesEvent {
  readonly eventType = 'sales.invoicing.requested'
  constructor(
    orderId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly order: {
      orderVersion: number
      customerId: string
      lines: readonly ConfirmedOrderLine[]
      total: Money
      installments: readonly AgreedInstallment[]
    },
  ) {
    super(orderId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      orderId: this.aggregateId.toString(),
      orderVersion: this.order.orderVersion,
      customerId: this.order.customerId,
      confirmedAt: this.occurredAt.toISOString(),
      lines: this.order.lines.map(confirmedLinePayload),
      total: {
        amount: this.order.total.amount.toString(),
        currency: this.order.total.currency.value,
      },
      installments: this.order.installments.map(installmentPayload),
    }
  }
}

export class SalesOrderCancelledEvent extends SalesEvent {
  readonly eventType = 'sales.order.cancelled'
  constructor(
    orderId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly cancellation: {
      orderVersion: number
      reservationId: string | null
      reason: string | null
    },
  ) {
    super(orderId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      orderId: this.aggregateId.toString(),
      orderVersion: this.cancellation.orderVersion,
      reservationId: this.cancellation.reservationId,
      cancelledAt: this.occurredAt.toISOString(),
      reason: this.cancellation.reason,
    }
  }
}

export class QuoteSentEvent extends SalesEvent {
  readonly eventType = 'sales.quote.sent'
  constructor(
    quoteId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly quote: {
      quoteRoot: string
      version: number
      customerId: string
      total: Money
      expiresAt: Date
    },
  ) {
    super(quoteId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      quoteId: this.aggregateId.toString(),
      quoteRoot: this.quote.quoteRoot,
      version: this.quote.version,
      customerId: this.quote.customerId,
      total: moneyPayload(this.quote.total),
      expiresAt: this.quote.expiresAt.toISOString(),
    }
  }
}

export class QuoteAcceptedEvent extends SalesEvent {
  readonly eventType = 'sales.quote.accepted'
  constructor(
    quoteId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly quote: {
      quoteRoot: string
      version: number
      customerId: string
      total: Money
    },
  ) {
    super(quoteId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      quoteId: this.aggregateId.toString(),
      quoteRoot: this.quote.quoteRoot,
      version: this.quote.version,
      customerId: this.quote.customerId,
      total: moneyPayload(this.quote.total),
    }
  }
}

export class QuoteRejectedEvent extends SalesEvent {
  readonly eventType = 'sales.quote.rejected'
  constructor(
    quoteId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly quote: {
      quoteRoot: string
      version: number
      customerId: string
      reason: string
    },
  ) {
    super(quoteId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      quoteId: this.aggregateId.toString(),
      quoteRoot: this.quote.quoteRoot,
      version: this.quote.version,
      customerId: this.quote.customerId,
      reason: this.quote.reason,
    }
  }
}
