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

/**
 * What a fiscal document would be written for: one delivery, at the order's own prices.
 *
 * Emitted when the goods leave rather than when the order is confirmed, because an invoice
 * is written for what was actually shipped — a partial delivery is a partial invoice.
 */
export class SalesInvoicingRequestedEvent extends SalesEvent {
  readonly eventType = 'sales.invoicing.requested'
  constructor(
    orderId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly order: {
      orderVersion: number
      customerId: string
      shipmentId: string
      confirmedAt: Date
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
      shipmentId: this.order.shipmentId,
      confirmedAt: this.order.confirmedAt.toISOString(),
      lines: this.order.lines.map(confirmedLinePayload),
      total: {
        amount: this.order.total.amount.toString(),
        currency: this.order.total.currency.value,
      },
      installments: this.order.installments.map(installmentPayload),
    }
  }
}

/** One immutable billable origin; the database key suppresses duplicate deliveries. */
export class SalesFiscalOriginRecordedEvent extends SalesEvent {
  readonly eventType = 'sales.fiscal-origin.recorded'
  constructor(
    orderId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly origin: {
      shipmentId: string
      purpose: 'original' | 'return'
      customerId: string
      lines: readonly ConfirmedOrderLine[]
      total: Money
    },
  ) {
    super(orderId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      orderId: this.aggregateId.toString(),
      originModule: 'sales',
      originDocumentType: 'shipment',
      originId: this.origin.shipmentId,
      purpose: this.origin.purpose,
      customerId: this.origin.customerId,
      lines: this.origin.lines.map(confirmedLinePayload),
      total: moneyPayload(this.origin.total),
    }
  }
}

const installmentsPayload = (installments: readonly AgreedInstallment[]) =>
  installments.map(installmentPayload)

/** What the order has still to deliver, and what one delivery carried out of it. */
export interface ShipmentFacts {
  readonly orderVersion: number
  readonly shipmentId: string
  readonly customerId: string
  readonly warehouseId: string
  readonly carrier: string | null
  readonly trackingCode: string | null
  readonly lines: readonly ConfirmedOrderLine[]
  readonly value: Money
  readonly remaining: Money
  readonly remainingInstallments: readonly AgreedInstallment[]
}

export class SalesShipmentDispatchedEvent extends SalesEvent {
  readonly eventType = 'sales.shipment.dispatched'
  constructor(
    orderId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly shipment: ShipmentFacts & {
      dispatchedBy: string
      dispatchedOn: BusinessDate
      installments: readonly AgreedInstallment[]
      complete: boolean
    },
  ) {
    super(orderId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      orderId: this.aggregateId.toString(),
      orderVersion: this.shipment.orderVersion,
      shipmentId: this.shipment.shipmentId,
      customerId: this.shipment.customerId,
      warehouseId: this.shipment.warehouseId,
      dispatchedBy: this.shipment.dispatchedBy,
      dispatchedOn: this.shipment.dispatchedOn.value,
      carrier: this.shipment.carrier,
      trackingCode: this.shipment.trackingCode,
      lines: this.shipment.lines.map(confirmedLinePayload),
      value: moneyPayload(this.shipment.value),
      installments: installmentsPayload(this.shipment.installments),
      remaining: moneyPayload(this.shipment.remaining),
      remainingInstallments: installmentsPayload(this.shipment.remainingInstallments),
      complete: this.shipment.complete,
    }
  }
}

export class SalesShipmentReturnedEvent extends SalesEvent {
  readonly eventType = 'sales.shipment.returned'
  constructor(
    orderId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly shipment: ShipmentFacts & {
      returnedBy: string
      returnedOn: BusinessDate
      reason: string
    },
  ) {
    super(orderId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      orderId: this.aggregateId.toString(),
      orderVersion: this.shipment.orderVersion,
      shipmentId: this.shipment.shipmentId,
      customerId: this.shipment.customerId,
      warehouseId: this.shipment.warehouseId,
      returnedBy: this.shipment.returnedBy,
      returnedOn: this.shipment.returnedOn.value,
      reason: this.shipment.reason,
      lines: this.shipment.lines.map(confirmedLinePayload),
      value: moneyPayload(this.shipment.value),
      remaining: moneyPayload(this.shipment.remaining),
      remainingInstallments: installmentsPayload(this.shipment.remainingInstallments),
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
