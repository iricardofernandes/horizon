import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import {
  type ConfirmedOrderLine,
  type RequestedOrderLine,
  SalesInvoicingRequestedEvent,
  SalesOrderCancelledEvent,
  SalesOrderConfirmedEvent,
  SalesOrderPlacedEvent,
} from '../events/sales-events'
import {
  type BusinessDate,
  type CarrierName,
  type Currency,
  type LineDescription,
  Money,
  type PaymentTerms,
  type Reason,
} from '../value-objects/sales-values'

export type SalesOrderStatus = 'draft' | 'placed' | 'confirmed' | 'rejected' | 'cancelled'

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
    this.addDomainEvent(
      new SalesInvoicingRequestedEvent(this.id, this.props.tenantId, now, eventProps),
    )
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
    version: number
    reservationId: string | null
    total: { amount: string; currency: string } | null
    createdAt: Date
    updatedAt: Date
    requestedLines: readonly {
      lineId: string
      itemId: string
      quantity: string
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
