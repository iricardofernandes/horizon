import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import type { BusinessDate, LineDescription, Money, Quantity } from '../value-objects/sales-values'

abstract class SalesEvent implements DomainEvent {
  abstract readonly eventType: string
  readonly eventVersion: number = 1
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

/** Frozen before dispatch for a warehouse under the Fiscal release policy. */
export class SalesFiscalOriginFrozenEvent extends SalesEvent {
  readonly eventType = 'sales.fiscal-origin.recorded'
  override readonly eventVersion = 2
  constructor(
    orderId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly origin: {
      shipmentId: string
      orderVersion: number
      customerId: string
      warehouseId: string
      establishmentId: string
      lines: readonly ConfirmedOrderLine[]
      total: Money
    },
  ) {
    super(orderId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      orderId: this.aggregateId.toString(),
      orderVersion: this.origin.orderVersion,
      originModule: 'sales',
      originDocumentType: 'shipment',
      originId: this.origin.shipmentId,
      originRevision: 1,
      purpose: 'original',
      customerId: this.origin.customerId,
      warehouseId: this.origin.warehouseId,
      establishmentId: this.origin.establishmentId,
      lines: this.origin.lines.map(confirmedLinePayload),
      total: moneyPayload(this.origin.total),
      preDispatch: true,
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

/**
 * The opportunity a quote was made for, with the owner and source Sales froze on the
 * offer's first version (Phase 58).
 */
export interface QuoteAttribution {
  readonly opportunityId: string
  readonly ownerId: string
  readonly sourceId: string | null
}

/** Only a quote made for an opportunity says so; the others keep their payload as it was. */
function attributionPayload(attribution: QuoteAttribution | null) {
  return attribution ? { attribution: { ...attribution } } : {}
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
      attribution: QuoteAttribution | null
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
      ...attributionPayload(this.quote.attribution),
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
      attribution: QuoteAttribution | null
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
      ...attributionPayload(this.quote.attribution),
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
      attribution: QuoteAttribution | null
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
      ...attributionPayload(this.quote.attribution),
      customerId: this.quote.customerId,
      reason: this.quote.reason,
    }
  }
}

/** One delivered line of a service order, as the delivery published it. */
export interface DeliveredServiceLine extends ConfirmedOrderLine {
  readonly entryId: string
  readonly amount: Money
}

export class SalesServiceDeliveredEvent extends SalesEvent {
  readonly eventType = 'sales.service.delivered'
  constructor(
    serviceOrderId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly delivery: {
      deliveryId: string
      customerId: string
      performedOn: BusinessDate
      deliveredBy: string
      lines: readonly DeliveredServiceLine[]
      value: Money
      installments: readonly AgreedInstallment[]
      complete: boolean
    },
  ) {
    super(serviceOrderId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      serviceOrderId: this.aggregateId.toString(),
      deliveryId: this.delivery.deliveryId,
      customerId: this.delivery.customerId,
      performedOn: this.delivery.performedOn.value,
      competence: this.delivery.performedOn.value.slice(0, 7),
      deliveredBy: this.delivery.deliveredBy,
      lines: this.delivery.lines.map((line) => ({
        entryId: line.entryId,
        lineId: line.lineId,
        itemId: line.itemId,
        description: line.description.value,
        quantity: line.quantity.toString(),
        unitPrice: moneyPayload(line.unitPrice),
        amount: moneyPayload(line.amount),
      })),
      value: moneyPayload(this.delivery.value),
      installments: this.delivery.installments.map(installmentPayload),
      complete: this.delivery.complete,
    }
  }
}

export class SalesServiceDeliveryCancelledEvent extends SalesEvent {
  readonly eventType = 'sales.service.delivery-cancelled'
  constructor(
    serviceOrderId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly cancellation: {
      deliveryId: string
      customerId: string
      performedOn: BusinessDate
      entryIds: readonly string[]
      cancelledOn: BusinessDate
      reason: string
    },
  ) {
    super(serviceOrderId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      serviceOrderId: this.aggregateId.toString(),
      deliveryId: this.cancellation.deliveryId,
      customerId: this.cancellation.customerId,
      competence: this.cancellation.performedOn.value.slice(0, 7),
      entryIds: [...this.cancellation.entryIds],
      cancelledOn: this.cancellation.cancelledOn.value,
      reason: this.cancellation.reason,
    }
  }
}

type ContractFacts = { customerId: string }

export class SalesContractActivatedEvent extends SalesEvent {
  readonly eventType = 'sales.contract.activated'
  constructor(
    contractId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly contract: ContractFacts & {
      revision: number
      recurrence: string
      startsOn: BusinessDate
      endsOn: BusinessDate | null
      billingDay: number
      autoRenew: boolean
    },
  ) {
    super(contractId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      contractId: this.aggregateId.toString(),
      customerId: this.contract.customerId,
      revision: this.contract.revision,
      recurrence: this.contract.recurrence,
      startsOn: this.contract.startsOn.value,
      endsOn: this.contract.endsOn?.value ?? null,
      billingDay: this.contract.billingDay,
      autoRenew: this.contract.autoRenew,
    }
  }
}

export class SalesContractAmendedEvent extends SalesEvent {
  readonly eventType = 'sales.contract.amended'
  constructor(
    contractId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly amendment: ContractFacts & {
      revision: number
      kind: 'amendment' | 'renewal'
      effectiveFrom: BusinessDate
      recurrence: string
      endsOn: BusinessDate | null
      readjustmentBasisPoints: number | null
    },
  ) {
    super(contractId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      contractId: this.aggregateId.toString(),
      customerId: this.amendment.customerId,
      revision: this.amendment.revision,
      kind: this.amendment.kind,
      effectiveFrom: this.amendment.effectiveFrom.value,
      recurrence: this.amendment.recurrence,
      endsOn: this.amendment.endsOn?.value ?? null,
      readjustmentBasisPoints: this.amendment.readjustmentBasisPoints,
    }
  }
}

export class SalesContractSuspendedEvent extends SalesEvent {
  readonly eventType = 'sales.contract.suspended'
  constructor(
    contractId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly suspension: ContractFacts & {
      suspensionId: string
      from: BusinessDate
      until: BusinessDate | null
      reason: string
    },
  ) {
    super(contractId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      contractId: this.aggregateId.toString(),
      customerId: this.suspension.customerId,
      suspensionId: this.suspension.suspensionId,
      from: this.suspension.from.value,
      until: this.suspension.until?.value ?? null,
      reason: this.suspension.reason,
    }
  }
}

export class SalesContractCancelledEvent extends SalesEvent {
  readonly eventType = 'sales.contract.cancelled'
  constructor(
    contractId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly cancellation: ContractFacts & { effectiveFrom: BusinessDate; reason: string },
  ) {
    super(contractId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      contractId: this.aggregateId.toString(),
      customerId: this.cancellation.customerId,
      effectiveFrom: this.cancellation.effectiveFrom.value,
      reason: this.cancellation.reason,
    }
  }
}

export class SalesContractPeriodBilledEvent extends SalesEvent {
  readonly eventType = 'sales.contract-period.billed'
  constructor(
    contractId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly period: ContractFacts & {
      billedPeriodId: string
      competence: string
      revision: number
      startsOn: BusinessDate
      endsOn: BusinessDate
      issuedOn: BusinessDate
      lines: readonly DeliveredServiceLine[]
      value: Money
      installments: readonly AgreedInstallment[]
      runId: string | null
      billedBy: string
    },
  ) {
    super(contractId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      contractId: this.aggregateId.toString(),
      billedPeriodId: this.period.billedPeriodId,
      customerId: this.period.customerId,
      competence: this.period.competence,
      revision: this.period.revision,
      startsOn: this.period.startsOn.value,
      endsOn: this.period.endsOn.value,
      issuedOn: this.period.issuedOn.value,
      lines: this.period.lines.map((line) => ({
        entryId: line.entryId,
        lineId: line.lineId,
        itemId: line.itemId,
        description: line.description.value,
        quantity: line.quantity.toString(),
        unitPrice: moneyPayload(line.unitPrice),
        amount: moneyPayload(line.amount),
      })),
      value: moneyPayload(this.period.value),
      installments: this.period.installments.map(installmentPayload),
      runId: this.period.runId,
      billedBy: this.period.billedBy,
    }
  }
}

export class SalesContractPeriodCreditedEvent extends SalesEvent {
  readonly eventType = 'sales.contract-period.credited'
  constructor(
    contractId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly credit: ContractFacts & {
      billedPeriodId: string
      competence: string
      entryIds: readonly string[]
      reasonCode: string
      reason: string
      creditedOn: BusinessDate
    },
  ) {
    super(contractId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      contractId: this.aggregateId.toString(),
      billedPeriodId: this.credit.billedPeriodId,
      customerId: this.credit.customerId,
      competence: this.credit.competence,
      entryIds: [...this.credit.entryIds],
      reasonCode: this.credit.reasonCode,
      reason: this.credit.reason,
      creditedOn: this.credit.creditedOn.value,
    }
  }
}

/** A billing run decided every contract of its month (Phase 66): who started it, and counts. */
export class BillingRunFinishedEvent extends SalesEvent {
  readonly eventType = 'sales.billing-run.finished'
  constructor(
    runId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly facts: {
      readonly competence: string
      readonly startedBy: string
      readonly billed: number
      readonly skipped: number
      readonly refused: number
    },
  ) {
    super(runId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return { runId: this.aggregateId.toString(), ...this.facts }
  }
}
