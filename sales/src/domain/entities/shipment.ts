import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { ConfirmedOrderLine } from '../events/sales-events'
import type {
  BusinessDate,
  CarrierName,
  Money,
  Reason,
  TrackingCode,
} from '../value-objects/sales-values'

export const SHIPMENT_STATUSES = [
  'picking',
  'packed',
  'dispatched',
  'returned',
  'abandoned',
] as const
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number]

interface ShipmentProps {
  tenantId: string
  orderId: string
  warehouseId: string
  lines: readonly ConfirmedOrderLine[]
  /** The share of the order's total these goods carry, and so what they made owed. */
  value: Money
  status: ShipmentStatus
  carrier: CarrierName | null
  trackingCode: TrackingCode | null
  pickedBy: string
  packedBy: string | null
  dispatchedBy: string | null
  dispatchedOn: BusinessDate | null
  returnedBy: string | null
  returnedOn: BusinessDate | null
  closure: Reason | null
  createdAt: Date
  updatedAt: Date
}

export interface ShipmentInput {
  readonly tenantId: string
  readonly orderId: string
  readonly warehouseId: string
  readonly lines: readonly ConfirmedOrderLine[]
  readonly value: Money
  readonly pickedBy: string
  readonly now: Date
}

/**
 * One delivery against a sales order: what is being taken off the shelf for the customer,
 * and — once it leaves — what it made owed.
 *
 * It exists before it is dispatched, because picking and packing take time and the
 * warehouse needs somewhere to write down what it is doing. Until it leaves, it is a plan
 * and may be abandoned; the moment it leaves it is the record of a physical event, and is
 * never edited. A delivery that turns out to be wrong comes back, which leaves both the
 * dispatch and the return in the record rather than replacing one with the other
 * (ADR 0042).
 */
export class Shipment extends AggregateRoot<ShipmentProps> {
  static pick(input: ShipmentInput, id?: UniqueEntityID): Shipment {
    return new Shipment(
      {
        tenantId: input.tenantId,
        orderId: input.orderId,
        warehouseId: input.warehouseId,
        lines: input.lines,
        value: input.value,
        status: 'picking',
        carrier: null,
        trackingCode: null,
        pickedBy: input.pickedBy,
        packedBy: null,
        dispatchedBy: null,
        dispatchedOn: null,
        returnedBy: null,
        returnedOn: null,
        closure: null,
        createdAt: input.now,
        updatedAt: input.now,
      },
      id,
    )
  }

  static rehydrate(props: ShipmentProps, id: UniqueEntityID): Shipment {
    return new Shipment(props, id)
  }

  get tenantId(): string {
    return this.props.tenantId
  }

  get orderId(): string {
    return this.props.orderId
  }

  get warehouseId(): string {
    return this.props.warehouseId
  }

  get status(): ShipmentStatus {
    return this.props.status
  }

  get value(): Money {
    return this.props.value
  }

  get carrier(): CarrierName | null {
    return this.props.carrier
  }

  get trackingCode(): TrackingCode | null {
    return this.props.trackingCode
  }

  lines(): readonly ConfirmedOrderLine[] {
    return this.props.lines
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  /** The goods are in the box. Who is carrying them can be said now or at dispatch. */
  pack(
    actor: string,
    consignment: { carrier: CarrierName | null; trackingCode: TrackingCode | null },
    now: Date,
  ): Either<ConflictError, void> {
    if (this.props.status !== 'picking')
      return left(new ConflictError(`a ${this.props.status} shipment cannot be packed`))
    this.props.status = 'packed'
    this.props.packedBy = actor
    this.props.carrier = consignment.carrier ?? this.props.carrier
    this.props.trackingCode = consignment.trackingCode ?? this.props.trackingCode
    this.props.updatedAt = now
    return right(undefined)
  }

  /**
   * The goods leave. Only a packed shipment goes: a box nobody closed is not a delivery,
   * and the order it belongs to is what publishes the fact.
   */
  dispatch(
    actor: string,
    consignment: {
      dispatchedOn: BusinessDate
      carrier: CarrierName | null
      trackingCode: TrackingCode | null
    },
    now: Date,
  ): Either<ConflictError, void> {
    if (this.props.status !== 'packed')
      return left(new ConflictError(`a ${this.props.status} shipment cannot be dispatched`))
    this.props.status = 'dispatched'
    this.props.dispatchedBy = actor
    this.props.dispatchedOn = consignment.dispatchedOn
    this.props.carrier = consignment.carrier ?? this.props.carrier
    this.props.trackingCode = consignment.trackingCode ?? this.props.trackingCode
    this.props.updatedAt = now
    return right(undefined)
  }

  /**
   * What the delivery turned out to be worth.
   *
   * Only the order can work it out — the share depends on what has already gone — and it
   * is only settled when the goods leave, so the shipment is told once, at dispatch.
   */
  carriedValue(value: Money): void {
    this.props.value = value
  }

  /** The customer sent it back, whole, with the reason they gave. */
  takeBack(
    actor: string,
    returnedOn: BusinessDate,
    reason: Reason,
    now: Date,
  ): Either<ConflictError, void> {
    if (this.props.status !== 'dispatched')
      return left(new ConflictError(`a ${this.props.status} shipment cannot be returned`))
    this.props.status = 'returned'
    this.props.returnedBy = actor
    this.props.returnedOn = returnedOn
    this.props.closure = reason
    this.props.updatedAt = now
    return right(undefined)
  }

  /** Nothing left the warehouse, so nothing happened: the goods go back on the shelf. */
  abandon(reason: Reason, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'picking' && this.props.status !== 'packed')
      return left(new ConflictError('a shipment that has left cannot be abandoned'))
    this.props.status = 'abandoned'
    this.props.closure = reason
    this.props.updatedAt = now
    return right(undefined)
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    orderId: string
    warehouseId: string
    status: ShipmentStatus
    value: { amount: string; currency: string }
    carrier: string | null
    trackingCode: string | null
    pickedBy: string
    packedBy: string | null
    dispatchedBy: string | null
    dispatchedOn: string | null
    returnedBy: string | null
    returnedOn: string | null
    closureReason: string | null
    createdAt: Date
    updatedAt: Date
    lines: readonly {
      lineId: string
      itemId: string
      quantity: string
      description: string
      unitPrice: { amount: string; currency: string }
      lineTotal: { amount: string; currency: string }
    }[]
  }> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      orderId: this.props.orderId,
      warehouseId: this.props.warehouseId,
      status: this.props.status,
      value: {
        amount: this.props.value.amount.toString(),
        currency: this.props.value.currency.value,
      },
      carrier: this.props.carrier?.value ?? null,
      trackingCode: this.props.trackingCode?.value ?? null,
      pickedBy: this.props.pickedBy,
      packedBy: this.props.packedBy,
      dispatchedBy: this.props.dispatchedBy,
      dispatchedOn: this.props.dispatchedOn?.value ?? null,
      returnedBy: this.props.returnedBy,
      returnedOn: this.props.returnedOn?.value ?? null,
      closureReason: this.props.closure?.value ?? null,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
      lines: this.props.lines.map((line) => ({
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
}
