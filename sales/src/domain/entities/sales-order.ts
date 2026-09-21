import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import {
  type AgreedInstallment,
  type ConfirmedOrderLine,
  type RequestedOrderLine,
  SalesFiscalOriginRecordedEvent,
  SalesInvoicingRequestedEvent,
  SalesOrderCancelledEvent,
  SalesOrderConfirmedEvent,
  SalesOrderPlacedEvent,
  SalesShipmentDispatchedEvent,
  SalesShipmentReturnedEvent,
} from '../events/sales-events'
import {
  merge,
  netOfShipped,
  priceShipment,
  quantityShipped,
  type ShipmentPlan,
  type ShippedLine,
  scheduleFrom,
  shareOf,
  subtract,
} from '../services/fulfilment'
import {
  type BusinessDate,
  type CarrierName,
  type Currency,
  type LineDescription,
  Money,
  type PaymentTerms,
  Quantity,
  type Reason,
  type TrackingCode,
} from '../value-objects/sales-values'

export type SalesOrderStatus = 'draft' | 'placed' | 'confirmed' | 'rejected' | 'cancelled'

/** How much of what was sold has actually reached the customer. */
export type FulfillmentState = 'unfulfilled' | 'partial' | 'fulfilled'

/** What the order says beyond the goods: who sold it, what it costs to deliver, when it is paid. */
export interface OrderTerms {
  readonly sellerId: string | null
  readonly discount: Money
  readonly freight: Money
  readonly carrier: CarrierName | null
  readonly paymentTerms: PaymentTerms
  readonly notes: string | null
}

interface SalesOrderProps {
  tenantId: string
  customerId: string
  fulfillmentWarehouseId: string
  quoteId: string | null
  requestedLines: readonly RequestedOrderLine[]
  /** What the customer was already quoted, when the order came from an accepted offer. */
  agreedLines: readonly CommercialLineInput[]
  confirmedLines: readonly ConfirmedOrderLine[]
  reservationId: string | null
  /** Held for a shipment that is being picked or packed, and not yet gone. */
  allocated: readonly ShippedLine[]
  /** Gone to the customer, and not returned. */
  shipped: readonly ShippedLine[]
  shipments: number
  /** When the commercial snapshot was frozen; the date an invoice would be written from. */
  confirmedAt: Date | null
  currency: Currency | null
  terms: OrderTerms
  issuedOn: BusinessDate
  total: Money | null
  status: SalesOrderStatus
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface CommercialLineInput {
  readonly lineId: string
  readonly itemId: string
  readonly description: LineDescription
  readonly unitPrice: Money
}

export class SalesOrder extends AggregateRoot<SalesOrderProps> {
  static rehydrate(props: SalesOrderProps, id: UniqueEntityID): SalesOrder {
    return new SalesOrder(props, id)
  }

  static draft(
    props: {
      tenantId: string
      customerId: string
      fulfillmentWarehouseId: string
      quoteId?: string | null
      terms: OrderTerms
      issuedOn: BusinessDate
      lines: readonly RequestedOrderLine[]
      agreedLines?: readonly CommercialLineInput[]
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<InvalidInputError, SalesOrder> {
    const checked = checkLines(props.lines)
    if (checked.isLeft()) return left(checked.value)
    return right(
      new SalesOrder(
        {
          tenantId: props.tenantId,
          customerId: props.customerId,
          fulfillmentWarehouseId: props.fulfillmentWarehouseId,
          quoteId: props.quoteId ?? null,
          requestedLines: props.lines,
          agreedLines: props.agreedLines ?? [],
          confirmedLines: [],
          reservationId: null,
          allocated: [],
          shipped: [],
          shipments: 0,
          confirmedAt: null,
          // The terms carry money from the moment the order is drafted, so the order has a
          // currency before its lines are priced: it is the one they were agreed in.
          currency: props.terms.discount.currency,
          terms: props.terms,
          issuedOn: props.issuedOn,
          total: null,
          status: 'draft',
          version: 0,
          createdAt: props.now,
          updatedAt: props.now,
        },
        id,
      ),
    )
  }
  /**
   * Change what a draft order says.
   *
   * Only a draft: once stock has been held against it and a customer has been told it was
   * placed, an amendment is a new agreement, and the honest way to record one is to cancel
   * this order and write another.
   */
  amend(
    change: { terms: OrderTerms; lines: readonly RequestedOrderLine[]; issuedOn: BusinessDate },
    now: Date,
  ): Either<InvalidInputError | ConflictError, void> {
    if (this.props.status !== 'draft')
      return left(new ConflictError('only a draft order can be amended'))
    const checked = checkLines(change.lines)
    if (checked.isLeft()) return left(checked.value)
    this.props.terms = change.terms
    this.props.requestedLines = change.lines
    this.props.agreedLines = []
    this.props.issuedOn = change.issuedOn
    this.advance(now)
    return right(undefined)
  }

  terms(): OrderTerms {
    return this.props.terms
  }

  get issuedOn(): BusinessDate {
    return this.props.issuedOn
  }

  get fulfillmentWarehouseId(): string {
    return this.props.fulfillmentWarehouseId
  }

  get quoteId(): string | null {
    return this.props.quoteId
  }

  place(now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'draft')
      return left(new ConflictError('only a draft order can be placed'))
    this.props.status = 'placed'
    this.advance(now)
    this.addDomainEvent(
      new SalesOrderPlacedEvent(this.id, this.props.tenantId, now, {
        orderVersion: this.props.version,
        customerId: this.props.customerId,
        fulfillmentWarehouseId: this.props.fulfillmentWarehouseId,
        lines: this.props.requestedLines,
      }),
    )
    return right(undefined)
  }
  confirm(
    handledOrderVersion: number,
    reservationId: string,
    commercialLines: readonly CommercialLineInput[],
    now: Date,
  ): Either<ConflictError, void> {
    if (this.props.status !== 'placed')
      return left(new ConflictError('only a placed order can be confirmed'))
    if (handledOrderVersion !== this.props.version)
      return left(new ConflictError('reservation outcome targets a stale order version'))
    const snapshots = this.snapshotLines(commercialLines)
    if (snapshots.isLeft()) return left(snapshots.value)
    const [first] = snapshots.value
    if (!first) return left(new ConflictError('confirmed order has no lines'))
    let total = Money.fromAmount(0n, first.unitPrice.currency)
    for (const line of snapshots.value) {
      if (!line.lineTotal.currency.equals(total.currency))
        return left(new ConflictError('all order lines must use one currency'))
      total = total.plus(line.lineTotal)
    }
    const { terms } = this.props
    // An order has no currency until its lines are priced, so terms agreed before that
    // carry nothing but an amount. Zero adopts whatever currency the lines turn out to be
    // in; anything else has to have been agreed in that currency already.
    const inCurrency = (money: Money, what: string): Either<ConflictError, Money> =>
      money.isZero()
        ? right(Money.fromAmount(0n, total.currency))
        : money.currency.equals(total.currency)
          ? right(money)
          : left(new ConflictError(`${what} must use the order currency`))
    const freight = inCurrency(terms.freight, 'freight')
    if (freight.isLeft()) return left(freight.value)
    const discount = inCurrency(terms.discount, 'the discount')
    if (discount.isLeft()) return left(discount.value)
    this.props.terms = { ...terms, freight: freight.value, discount: discount.value }
    const charged = total.plus(freight.value)
    if (charged.isLessThan(discount.value))
      return left(new ConflictError('a discount cannot exceed what is charged'))
    const owed = charged.minus(discount.value)
    this.props.status = 'confirmed'
    this.props.reservationId = reservationId
    this.props.confirmedLines = snapshots.value
    this.props.currency = total.currency
    this.props.total = owed
    this.advance(now)
    const eventProps = {
      orderVersion: this.props.version,
      customerId: this.props.customerId,
      reservationId,
      lines: snapshots.value,
      total: owed,
      // The schedule the agreed terms imply, already dated, so Financial raises the
      // receivable on what was actually agreed rather than on one instalment it invented.
      installments: terms.paymentTerms.scheduleOf(owed, this.props.issuedOn),
    }
    this.addDomainEvent(new SalesOrderConfirmedEvent(this.id, this.props.tenantId, now, eventProps))
    this.props.confirmedAt = now
    return right(undefined)
  }

  /** How much of a line has still to reach the customer; zero once it all has. */
  outstandingOf(lineId: string): Quantity | null {
    const ordered = this.props.requestedLines.find((line) => line.lineId === lineId)
    if (!ordered) return null
    const committed = quantityShipped(merge(this.props.shipped, this.props.allocated), lineId)
    if (!committed) return ordered.quantity
    return committed.isLessThan(ordered.quantity)
      ? ordered.quantity.minus(committed)
      : Quantity.fromMicros(0n)
  }

  shippedSoFar(): readonly ShippedLine[] {
    return this.props.shipped
  }

  fulfillment(): FulfillmentState {
    if (this.props.shipped.length === 0) return 'unfulfilled'
    return this.props.confirmedLines.every((line) => {
      const gone = quantityShipped(this.props.shipped, line.lineId)
      return gone !== undefined && !gone.isLessThan(line.quantity)
    })
      ? 'fulfilled'
      : 'partial'
  }

  /**
   * Take goods off the shelf for a delivery that has not left yet.
   *
   * Picking holds the quantities against the order, so two shipments being prepared at
   * once cannot both promise the same units — the second one finds them already spoken
   * for. Nothing is owed and nothing has moved: that happens when the box leaves.
   */
  allocate(
    lines: readonly ShippedLine[],
    now: Date,
  ): Either<InvalidInputError | ConflictError, readonly ConfirmedOrderLine[]> {
    if (this.props.status !== 'confirmed')
      return left(new ConflictError(`a ${this.props.status} order is not shipping anything`))
    const checked = this.checkAgainstOutstanding(lines)
    if (checked.isLeft()) return left(checked.value)
    this.props.allocated = merge(this.props.allocated, lines)
    this.advance(now)
    return right(priceShipment(this.props.confirmedLines, lines))
  }

  /** The delivery was abandoned before it left: the goods are free to be promised again. */
  releaseAllocation(lines: readonly ShippedLine[], now: Date): Either<ConflictError, void> {
    const left_ = subtract(this.props.allocated, lines)
    if (!left_) return left(new ConflictError('these goods were not held for a shipment'))
    this.props.allocated = left_
    this.advance(now)
    return right(undefined)
  }

  /**
   * The goods leave for the customer.
   *
   * What the delivery makes owed is its share of the order's total, because freight and
   * the discount were agreed for the order as a whole. What has not left is still only
   * expected, so the schedule for the rest is published beside it: the two always add back
   * up to the order.
   */
  dispatch(
    delivery: { readonly lines: readonly ShippedLine[]; readonly dispatchedOn: BusinessDate },
    now: Date,
  ): Either<InvalidInputError | ConflictError, ShipmentPlan> {
    if (this.props.status !== 'confirmed')
      return left(new ConflictError(`a ${this.props.status} order is not shipping anything`))
    if (delivery.dispatchedOn.isBefore(this.props.issuedOn))
      return left(
        new InvalidInputError('/dispatchedOn', 'goods cannot leave before the order was issued'),
      )
    const released = subtract(this.props.allocated, delivery.lines)
    if (!released) return left(new ConflictError('these goods were not held for this shipment'))
    const plan = this.planOf(delivery.lines, delivery.dispatchedOn)
    this.props.allocated = released
    this.props.shipped = merge(this.props.shipped, delivery.lines)
    this.props.shipments += 1
    this.advance(now)
    return right(plan)
  }

  /**
   * A delivery came back. What it made owed goes with it, and the order owes those goods
   * to the customer again — which is what puts them back among what is still to ship.
   */
  unship(
    lines: readonly ShippedLine[],
    now: Date,
  ): Either<
    ConflictError,
    { value: Money; remaining: Money; remainingInstallments: readonly AgreedInstallment[] }
  > {
    if (this.props.shipments === 0)
      return left(new ConflictError('nothing has left against this order'))
    const kept = subtract(this.props.shipped, lines)
    if (!kept) return left(new ConflictError('more was returned than ever left'))
    const before = this.shareShipped()
    this.props.shipped = kept
    this.props.shipments -= 1
    this.advance(now)
    const after = this.shareShipped()
    const remaining = this.stillToShip()
    return right({
      value: before.minus(after),
      remaining,
      remainingInstallments: scheduleFrom(
        this.props.terms.paymentTerms,
        remaining,
        this.props.issuedOn,
      ),
    })
  }

  /** The facts a dispatch publishes, so every story it starts reads from one payload. */
  dispatchEvent(
    shipment: {
      readonly shipmentId: string
      readonly warehouseId: string
      readonly carrier: CarrierName | null
      readonly trackingCode: TrackingCode | null
      readonly dispatchedBy: string
      readonly dispatchedOn: BusinessDate
    },
    plan: ShipmentPlan,
    now: Date,
  ): void {
    const facts = {
      orderVersion: this.props.version,
      shipmentId: shipment.shipmentId,
      customerId: this.props.customerId,
      warehouseId: shipment.warehouseId,
      carrier: shipment.carrier?.value ?? null,
      trackingCode: shipment.trackingCode?.value ?? null,
      lines: plan.lines,
      value: plan.value,
      remaining: plan.remaining,
      remainingInstallments: plan.remainingInstallments,
    }
    this.addDomainEvent(
      new SalesShipmentDispatchedEvent(this.id, this.props.tenantId, now, {
        ...facts,
        dispatchedBy: shipment.dispatchedBy,
        dispatchedOn: shipment.dispatchedOn,
        installments: plan.installments,
        complete: plan.complete,
      }),
    )
    // An invoice is written for what was actually shipped, so it is asked for here.
    this.addDomainEvent(
      new SalesInvoicingRequestedEvent(this.id, this.props.tenantId, now, {
        orderVersion: this.props.version,
        customerId: this.props.customerId,
        shipmentId: shipment.shipmentId,
        confirmedAt: this.props.confirmedAt ?? now,
        lines: plan.lines,
        total: plan.value,
        installments: plan.installments,
      }),
    )
    this.addDomainEvent(
      new SalesFiscalOriginRecordedEvent(this.id, this.props.tenantId, now, {
        shipmentId: shipment.shipmentId,
        purpose: 'original',
        customerId: this.props.customerId,
        lines: plan.lines,
        total: plan.value,
      }),
    )
  }

  returnEvent(
    shipment: {
      readonly shipmentId: string
      readonly warehouseId: string
      readonly carrier: CarrierName | null
      readonly trackingCode: TrackingCode | null
      readonly returnedBy: string
      readonly returnedOn: BusinessDate
      readonly reason: Reason
      readonly lines: readonly ConfirmedOrderLine[]
    },
    undone: { value: Money; remaining: Money; remainingInstallments: readonly AgreedInstallment[] },
    now: Date,
  ): void {
    this.addDomainEvent(
      new SalesShipmentReturnedEvent(this.id, this.props.tenantId, now, {
        orderVersion: this.props.version,
        shipmentId: shipment.shipmentId,
        customerId: this.props.customerId,
        warehouseId: shipment.warehouseId,
        carrier: shipment.carrier?.value ?? null,
        trackingCode: shipment.trackingCode?.value ?? null,
        returnedBy: shipment.returnedBy,
        returnedOn: shipment.returnedOn,
        reason: shipment.reason.value,
        lines: shipment.lines,
        value: undone.value,
        remaining: undone.remaining,
        remainingInstallments: undone.remainingInstallments,
      }),
    )
    this.addDomainEvent(
      new SalesFiscalOriginRecordedEvent(this.id, this.props.tenantId, now, {
        shipmentId: shipment.shipmentId,
        purpose: 'return',
        customerId: this.props.customerId,
        lines: shipment.lines,
        total: undone.value,
      }),
    )
  }

  /** What one more delivery would make owed, and what would be left expected after it. */
  private planOf(lines: readonly ShippedLine[], dispatchedOn: BusinessDate): ShipmentPlan {
    const currency = this.currencyOf()
    const total = this.props.total ?? Money.fromAmount(0n, currency)
    const net = netOf(this.props.confirmedLines, currency)
    const before = shareOf(
      total,
      net,
      netOfShipped(this.props.confirmedLines, this.props.shipped, currency),
    )
    const after = shareOf(
      total,
      net,
      netOfShipped(this.props.confirmedLines, merge(this.props.shipped, lines), currency),
    )
    const value = after.minus(before)
    const remaining = total.minus(after)
    const complete = this.props.confirmedLines.every((line) => {
      const gone = quantityShipped(merge(this.props.shipped, lines), line.lineId)
      return gone !== undefined && !gone.isLessThan(line.quantity)
    })
    const { paymentTerms } = this.props.terms
    return {
      lines: priceShipment(this.props.confirmedLines, lines),
      value,
      installments: scheduleFrom(paymentTerms, value, dispatchedOn),
      remaining,
      remainingInstallments: scheduleFrom(paymentTerms, remaining, this.props.issuedOn),
      complete,
    }
  }

  /** The share of the order's total that everything shipped so far carries. */
  private shareShipped(): Money {
    const currency = this.currencyOf()
    const total = this.props.total ?? Money.fromAmount(0n, currency)
    return shareOf(
      total,
      netOf(this.props.confirmedLines, currency),
      netOfShipped(this.props.confirmedLines, this.props.shipped, currency),
    )
  }

  private stillToShip(): Money {
    const total = this.props.total ?? Money.fromAmount(0n, this.currencyOf())
    return total.minus(this.shareShipped())
  }

  private currencyOf(): Currency {
    const currency = this.props.currency
    if (!currency) throw new Error('an order has no currency until its lines are priced')
    return currency
  }

  private checkAgainstOutstanding(
    lines: readonly ShippedLine[],
  ): Either<InvalidInputError | ConflictError, void> {
    if (lines.length === 0)
      return left(new InvalidInputError('/lines', 'a shipment requires at least one line'))
    if (new Set(lines.map((line) => line.lineId)).size !== lines.length)
      return left(new InvalidInputError('/lines', 'ship each line once, in a single row'))
    for (const line of lines) {
      if (line.quantity.isZero())
        return left(new InvalidInputError('/lines/quantity', 'shipped quantities must be positive'))
      const outstanding = this.outstandingOf(line.lineId)
      if (outstanding === null) return left(new ConflictError('this order has no such line'))
      if (outstanding.isLessThan(line.quantity))
        return left(new ConflictError('more was picked than the order still has to deliver'))
    }
    return right(undefined)
  }
  rejectReservation(handledOrderVersion: number, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'placed')
      return left(new ConflictError('only a placed order can reject a reservation'))
    if (handledOrderVersion !== this.props.version)
      return left(new ConflictError('reservation outcome targets a stale order version'))
    this.props.status = 'rejected'
    this.advance(now)
    return right(undefined)
  }
  cancel(reason: Reason | null, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'draft' && this.props.status !== 'placed')
      return left(new ConflictError('order can no longer be cancelled'))
    this.props.status = 'cancelled'
    this.advance(now)
    this.addDomainEvent(
      new SalesOrderCancelledEvent(this.id, this.props.tenantId, now, {
        orderVersion: this.props.version,
        reservationId: this.props.reservationId,
        reason: reason?.value ?? null,
      }),
    )
    return right(undefined)
  }
  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }
  requestedLines(): readonly RequestedOrderLine[] {
    return this.props.requestedLines
  }
  /**
   * The prices the customer already agreed to, when this order came from a quote.
   *
   * An order converted from an accepted offer is confirmed at what was negotiated, not at
   * whatever the catalogue happens to say by the time stock is held: a price list that
   * moved between the yes and the reservation is not a new agreement.
   */
  agreedLines(): readonly CommercialLineInput[] {
    return this.props.agreedLines
  }
  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    customerId: string
    fulfillmentWarehouseId: string
    quoteId: string | null
    sellerId: string | null
    currency: string | null
    discount: string
    freight: string
    carrier: string | null
    paymentTermDays: readonly number[]
    issuedOn: string
    notes: string | null
    status: SalesOrderStatus
    fulfillment: FulfillmentState
    shipments: number
    confirmedAt: Date | null
    version: number
    reservationId: string | null
    total: { amount: string; currency: string } | null
    createdAt: Date
    updatedAt: Date
    requestedLines: readonly {
      lineId: string
      itemId: string
      quantity: string
      shipped: string
      allocated: string
      description?: string
      unitPrice?: { amount: string; currency: string }
      lineTotal?: { amount: string; currency: string }
    }[]
    confirmedLines: readonly {
      lineId: string
      itemId: string
      quantity: string
      description: string
      unitPrice: { amount: string; currency: string }
      lineTotal: { amount: string; currency: string }
    }[]
  }> {
    const total = this.props.total
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      customerId: this.props.customerId,
      fulfillmentWarehouseId: this.props.fulfillmentWarehouseId,
      quoteId: this.props.quoteId,
      sellerId: this.props.terms.sellerId,
      currency: this.props.currency?.value ?? null,
      discount: this.props.terms.discount.amount.toString(),
      freight: this.props.terms.freight.amount.toString(),
      carrier: this.props.terms.carrier?.value ?? null,
      paymentTermDays: this.props.terms.paymentTerms.days,
      issuedOn: this.props.issuedOn.value,
      notes: this.props.terms.notes,
      status: this.props.status,
      fulfillment: this.fulfillment(),
      shipments: this.props.shipments,
      confirmedAt: this.props.confirmedAt,
      version: this.props.version,
      reservationId: this.props.reservationId,
      total: total ? { amount: total.amount.toString(), currency: total.currency.value } : null,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
      // A requested line carries a price only when one was already agreed on a quote:
      // an order nobody quoted is priced at confirmation, and says so by saying nothing.
      requestedLines: this.props.requestedLines.map((line) => {
        const agreed = this.props.agreedLines.find((priced) => priced.lineId === line.lineId)
        const base = {
          lineId: line.lineId,
          itemId: line.itemId,
          quantity: line.quantity.toString(),
          shipped: (quantityShipped(this.props.shipped, line.lineId) ?? ZERO).toString(),
          allocated: (quantityShipped(this.props.allocated, line.lineId) ?? ZERO).toString(),
        }
        if (!agreed) return base
        const lineTotal = agreed.unitPrice.multiply(line.quantity)
        return {
          ...base,
          description: agreed.description.value,
          unitPrice: {
            amount: agreed.unitPrice.amount.toString(),
            currency: agreed.unitPrice.currency.value,
          },
          lineTotal: { amount: lineTotal.amount.toString(), currency: lineTotal.currency.value },
        }
      }),
      confirmedLines: this.props.confirmedLines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        quantity: line.quantity.toString(),
        description: line.description.value,
        unitPrice: {
          amount: line.unitPrice.amount.toString(),
          currency: line.unitPrice.currency.value,
        },
        lineTotal: {
          amount: line.lineTotal.amount.toString(),
          currency: line.lineTotal.currency.value,
        },
      })),
    })
  }
  private snapshotLines(
    commercialLines: readonly CommercialLineInput[],
  ): Either<ConflictError, readonly ConfirmedOrderLine[]> {
    if (commercialLines.length !== this.props.requestedLines.length)
      return left(new ConflictError('commercial snapshot does not match requested lines'))
    const byId = new Map(commercialLines.map((line) => [line.lineId, line]))
    const snapshots: ConfirmedOrderLine[] = []
    for (const requested of this.props.requestedLines) {
      const commercial = byId.get(requested.lineId)
      if (!commercial || commercial.itemId !== requested.itemId)
        return left(new ConflictError('commercial snapshot does not match requested lines'))
      snapshots.push({
        ...requested,
        description: commercial.description,
        unitPrice: commercial.unitPrice,
        lineTotal: commercial.unitPrice.multiply(requested.quantity),
      })
    }
    return right(snapshots)
  }
  private advance(now: Date): void {
    this.props.version += 1
    this.props.updatedAt = now
  }
}

const ZERO = Quantity.fromMicros(0n)

/** The goods of the order alone, before freight and the discount. */
function netOf(lines: readonly ConfirmedOrderLine[], currency: Currency): Money {
  return lines.reduce((sum, line) => sum.plus(line.lineTotal), Money.fromAmount(0n, currency))
}

function checkLines(lines: readonly RequestedOrderLine[]): Either<InvalidInputError, void> {
  if (lines.length === 0)
    return left(new InvalidInputError('/lines', 'an order requires at least one line'))
  if (lines.some((line) => line.quantity.isZero()))
    return left(new InvalidInputError('/lines/quantity', 'order quantities must be positive'))
  if (new Set(lines.map((line) => line.lineId)).size !== lines.length)
    return left(new InvalidInputError('/lines', 'line identifiers must be unique'))
  if (new Set(lines.map((line) => line.itemId)).size !== lines.length)
    return left(new InvalidInputError('/lines', 'item identifiers must be unique'))
  return right(undefined)
}
