import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import {
  InventoryStockReleasedEvent,
  InventoryStockReservedEvent,
  type ReservationEventLine,
} from '../events/inventory-events'

export type ReservationStatus = 'active' | 'confirmed' | 'released'

interface StockReservationProps {
  tenantId: string
  orderId: string
  orderVersion: number
  lines: readonly ReservationEventLine[]
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
      { ...props, status: 'active', createdAt: props.now, updatedAt: props.now },
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
    lines: readonly { lineId: string; itemId: string; warehouseId: string; quantity: string }[]
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
      lines: this.props.lines.map((line) => ({ ...line, quantity: line.quantity.toString() })),
      status: this.props.status,
      expiresAt: this.props.expiresAt,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
