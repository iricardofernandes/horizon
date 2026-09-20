import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import type { Money, Quantity } from '../value-objects/inventory-values'
import type { MovementOrigin } from '../value-objects/movement-origin'

abstract class InventoryEvent implements DomainEvent {
  abstract readonly eventType: string
  readonly eventVersion = 1
  constructor(
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    readonly occurredAt: Date,
  ) {}
  abstract payloadOf(): Readonly<Record<string, unknown>>
}

export interface ReservationEventLine {
  readonly lineId: string
  readonly itemId: string
  readonly warehouseId: string
  readonly quantity: Quantity
}

export interface ReservationShortfall extends ReservationEventLine {
  readonly availableQuantity: Quantity
}

export class InventoryStockReservationRejectedEvent extends InventoryEvent {
  readonly eventType = 'inventory.stock.reservation-rejected'
  constructor(
    orderId: string,
    tenantId: string,
    occurredAt: Date,
    private readonly rejection: {
      orderVersion: number
      shortfalls: readonly ReservationShortfall[]
    },
  ) {
    super(new UniqueEntityID(orderId), tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      orderId: this.aggregateId.toString(),
      orderVersion: this.rejection.orderVersion,
      shortfalls: this.rejection.shortfalls.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        quantity: line.quantity.toString(),
        availableQuantity: line.availableQuantity.toString(),
      })),
    }
  }
}

export class InventoryStockReservedEvent extends InventoryEvent {
  readonly eventType = 'inventory.stock.reserved'
  constructor(
    reservationId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly reservation: {
      orderId: string
      orderVersion: number
      expiresAt: Date
      lines: readonly ReservationEventLine[]
    },
  ) {
    super(reservationId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      orderId: this.reservation.orderId,
      orderVersion: this.reservation.orderVersion,
      reservationId: this.aggregateId.toString(),
      expiresAt: this.reservation.expiresAt.toISOString(),
      lines: this.reservation.lines.map((line) => ({
        ...line,
        quantity: line.quantity.toString(),
      })),
    }
  }
}

export class InventoryStockReleasedEvent extends InventoryEvent {
  readonly eventType = 'inventory.stock.released'
  constructor(
    reservationId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly release: {
      orderId: string
      orderVersion: number
      reason: 'cancelled' | 'expired'
    },
  ) {
    super(reservationId, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      orderId: this.release.orderId,
      orderVersion: this.release.orderVersion,
      reservationId: this.aggregateId.toString(),
      reason: this.release.reason,
      releasedAt: this.occurredAt.toISOString(),
    }
  }
}

export class InventoryStockMovedEvent extends InventoryEvent {
  readonly eventType = 'inventory.stock.moved'
  constructor(
    balanceId: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly movement: {
      movementId: string
      itemId: string
      warehouseId: string
      kind:
        | 'receipt'
        | 'shipment'
        | 'adjustment-in'
        | 'adjustment-out'
        | 'return-in'
        | 'transfer-in'
        | 'transfer-out'
      balanceVersion: number
      quantity: Quantity
      balanceAfter: Quantity
      unitCost: Money | null
      /** Why it moved and under which document; absent for a sale or a purchase. */
      origin: MovementOrigin | null
    },
  ) {
    super(balanceId, tenantId, occurredAt)
  }
  movementOf(): Readonly<typeof this.movement> {
    return this.movement
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return {
      movementId: this.movement.movementId,
      itemId: this.movement.itemId,
      warehouseId: this.movement.warehouseId,
      kind: this.movement.kind,
      balanceVersion: this.movement.balanceVersion,
      quantity: this.movement.quantity.toString(),
      balanceAfter: this.movement.balanceAfter.toString(),
      unitCost: this.movement.unitCost
        ? {
            amount: this.movement.unitCost.amount.toString(),
            currency: this.movement.unitCost.currency.value,
          }
        : null,
      // Omitted rather than null when there is none: the field is optional on the wire,
      // so a consumer written before it existed sees exactly the payload it expects.
      ...(this.movement.origin
        ? { reason: this.movement.origin.reason, document: this.movement.origin.document }
        : {}),
    }
  }
}
