import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import {
  InventoryStockReleasedEvent,
  InventoryStockReservedEvent,
  type ReservationEventLine,
} from '../events/inventory-events'
import { Quantity } from '../value-objects/inventory-values'

function merge(
  shipped: readonly ShippedLine[],
  delivery: readonly ShippedLine[],
): readonly ShippedLine[] {
  const merged = new Map(shipped.map((line) => [line.lineId, line]))
  for (const line of delivery) {
    const existing = merged.get(line.lineId)
    merged.set(line.lineId, {
      lineId: line.lineId,
      quantity: existing ? existing.quantity.plus(line.quantity) : line.quantity,
    })
  }
  return [...merged.values()]
}

function subtract(
  shipped: readonly ShippedLine[],
  returned: readonly ShippedLine[],
): readonly ShippedLine[] | null {
  const remaining = new Map(shipped.map((line) => [line.lineId, line]))
  for (const line of returned) {
    const existing = remaining.get(line.lineId)
    if (!existing || existing.quantity.isLessThan(line.quantity)) return null
    const left = existing.quantity.minus(line.quantity)
    if (left.isZero()) remaining.delete(line.lineId)
    else remaining.set(line.lineId, { lineId: line.lineId, quantity: left })
  }
  return [...remaining.values()]
}

export type ReservationStatus = 'active' | 'confirmed' | 'shipped' | 'released'

/** How much of a reserved line has already left the warehouse. */
export interface ShippedLine {
  readonly lineId: string
  readonly quantity: Quantity
}

interface StockReservationProps {
  tenantId: string
  orderId: string
  orderVersion: number
  lines: readonly ReservationEventLine[]
  shipped: readonly ShippedLine[]
  status: ReservationStatus
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

export class StockReservation extends AggregateRoot<StockReservationProps> {
  static rehydrate(props: StockReservationProps, id: UniqueEntityID): StockReservation {
    return new StockReservation(props, id)
  }

  static accept(
    props: {
      tenantId: string
      orderId: string
      orderVersion: number
      lines: readonly ReservationEventLine[]
      expiresAt: Date
      now: Date
    },
    id?: UniqueEntityID,
  ): StockReservation {
    if (props.lines.length === 0) throw new RangeError('a reservation requires at least one line')
    if (props.lines.some((line) => line.quantity.isZero()))
      throw new RangeError('reservation quantities must be positive')
    if (!Number.isSafeInteger(props.orderVersion) || props.orderVersion < 1)
      throw new RangeError('order version must be a positive safe integer')
    if (props.expiresAt.getTime() <= props.now.getTime())
      throw new RangeError('reservation expiry must be after creation')
    const reservation = new StockReservation(
      { ...props, shipped: [], status: 'active', createdAt: props.now, updatedAt: props.now },
      id,
    )
    reservation.addDomainEvent(
      new InventoryStockReservedEvent(reservation.id, props.tenantId, props.now, props),
    )
    return reservation
  }
  confirm(orderVersion: number, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'active')
      return left(new ConflictError('only an active reservation can be confirmed'))
    if (this.isExpired(now)) return left(new ConflictError('reservation has expired'))
    if (orderVersion <= this.props.orderVersion)
      return left(new ConflictError('confirmation targets a stale order version'))
    this.props.status = 'confirmed'
    this.props.orderVersion = orderVersion
    this.props.updatedAt = now
    return right(undefined)
  }
  /**
   * Part or all of what is held leaves for the customer.
   *
   * A confirmed reservation is a promise that has been committed to, so the goods stay
   * held until they actually go — and they can go in more than one delivery, which is why
   * this counts what has left rather than closing the whole reservation at once.
   */
  dispatch(lines: readonly ShippedLine[], now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'confirmed')
      return left(new ConflictError('only a confirmed reservation ships goods'))
    for (const line of lines) {
      const outstanding = this.outstandingOf(line.lineId)
      if (outstanding === null) return left(new ConflictError('this reservation has no such line'))
      if (outstanding.isLessThan(line.quantity))
        return left(new ConflictError('more was shipped than this reservation holds'))
    }
    this.props.shipped = merge(this.props.shipped, lines)
    if (this.isComplete()) this.props.status = 'shipped'
    this.props.updatedAt = now
    return right(undefined)
  }

  /** A delivery came back: the goods are held for this order again. */
  takeBack(lines: readonly ShippedLine[], now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'confirmed' && this.props.status !== 'shipped')
      return left(new ConflictError('nothing has shipped against this reservation'))
    const kept = subtract(this.props.shipped, lines)
    if (!kept) return left(new ConflictError('more was returned than ever shipped'))
    this.props.shipped = kept
    this.props.status = 'confirmed'
    this.props.updatedAt = now
    return right(undefined)
  }

  /** What is still held for this line and has not left; zero once it all has. */
  outstandingOf(lineId: string): Quantity | null {
    const held = this.props.lines.find((line) => line.lineId === lineId)
    if (!held) return null
    const gone = this.props.shipped.find((line) => line.lineId === lineId)?.quantity
    if (!gone) return held.quantity
    return gone.isLessThan(held.quantity) ? held.quantity.minus(gone) : Quantity.fromMicros(0n)
  }

  shippedSoFar(): readonly ShippedLine[] {
    return this.props.shipped
  }

  private isComplete(): boolean {
    return this.props.lines.every((line) => this.outstandingOf(line.lineId)?.isZero() ?? false)
  }

  release(
    reason: 'cancelled' | 'expired',
    orderVersion: number,
    now: Date,
  ): Either<ConflictError, void> {
    if (this.props.status !== 'active')
      return left(new ConflictError('only an active reservation can be released'))
    if (reason === 'cancelled' && orderVersion <= this.props.orderVersion)
      return left(new ConflictError('cancellation targets a stale order version'))
    this.props.status = 'released'
    this.props.orderVersion = orderVersion
    this.props.updatedAt = now
    this.addDomainEvent(
      new InventoryStockReleasedEvent(this.id, this.props.tenantId, now, {
        orderId: this.props.orderId,
        orderVersion: this.props.orderVersion,
        reason,
      }),
    )
    return right(undefined)
  }
  isExpired(at: Date): boolean {
    return this.props.expiresAt.getTime() <= at.getTime()
  }
  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }
  orderIdentifier(): string {
    return this.props.orderId
  }
  orderVersion(): number {
    return this.props.orderVersion
  }
  lines(): readonly ReservationEventLine[] {
    return this.props.lines
  }
  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    orderId: string
    orderVersion: number
    lines: readonly {
      lineId: string
      itemId: string
      warehouseId: string
      quantity: string
      shipped: string
    }[]
    status: ReservationStatus
    expiresAt: Date
    createdAt: Date
    updatedAt: Date
  }> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      orderId: this.props.orderId,
      orderVersion: this.props.orderVersion,
      lines: this.props.lines.map((line) => ({
        ...line,
        quantity: line.quantity.toString(),
        shipped: (
          this.props.shipped.find((gone) => gone.lineId === line.lineId)?.quantity ??
          Quantity.fromMicros(0n)
        ).toString(),
      })),
      status: this.props.status,
      expiresAt: this.props.expiresAt,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
