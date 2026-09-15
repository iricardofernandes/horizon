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
import { type CancellationReason, type LineDescription, Money } from '../value-objects/sales-values'

export type SalesOrderStatus = 'draft' | 'placed' | 'confirmed' | 'rejected' | 'cancelled'

interface SalesOrderProps {
  tenantId: string
  customerId: string
  fulfillmentWarehouseId: string
  requestedLines: readonly RequestedOrderLine[]
  confirmedLines: readonly ConfirmedOrderLine[]
  reservationId: string | null
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
      lines: readonly RequestedOrderLine[]
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<InvalidInputError, SalesOrder> {
    if (props.lines.length === 0)
      return left(new InvalidInputError('/lines', 'an order requires at least one line'))
    if (props.lines.some((line) => line.quantity.isZero()))
      return left(new InvalidInputError('/lines/quantity', 'order quantities must be positive'))
    if (new Set(props.lines.map((line) => line.lineId)).size !== props.lines.length)
      return left(new InvalidInputError('/lines', 'line identifiers must be unique'))
    if (new Set(props.lines.map((line) => line.itemId)).size !== props.lines.length)
      return left(new InvalidInputError('/lines', 'item identifiers must be unique'))
    return right(
      new SalesOrder(
        {
          tenantId: props.tenantId,
          customerId: props.customerId,
          fulfillmentWarehouseId: props.fulfillmentWarehouseId,
          requestedLines: props.lines,
          confirmedLines: [],
          reservationId: null,
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
    this.props.status = 'confirmed'
    this.props.reservationId = reservationId
    this.props.confirmedLines = snapshots.value
    this.props.total = total
    this.advance(now)
    const eventProps = {
      orderVersion: this.props.version,
      customerId: this.props.customerId,
      reservationId,
      lines: snapshots.value,
      total,
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
  cancel(reason: CancellationReason | null, now: Date): Either<ConflictError, void> {
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
  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    customerId: string
    fulfillmentWarehouseId: string
    status: SalesOrderStatus
    version: number
    reservationId: string | null
    total: { amount: string; currency: string } | null
    createdAt: Date
    updatedAt: Date
    requestedLines: readonly { lineId: string; itemId: string; quantity: string }[]
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
      status: this.props.status,
      version: this.props.version,
      reservationId: this.props.reservationId,
      total: total ? { amount: total.amount.toString(), currency: total.currency.value } : null,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
      requestedLines: this.props.requestedLines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        quantity: line.quantity.toString(),
      })),
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
