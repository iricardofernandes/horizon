import {
  type EventEnvelope,
  salesOrderCancelled,
  salesOrderConfirmed,
  salesOrderPlaced,
} from '@horizon/contracts'
import type { EventHandler } from '@/infrastructure/messaging/rabbitmq-transport'
import type { Clock } from './ports/clock'
import type { InventoryUnitOfWork } from './ports/unit-of-work'
import { ConfirmReservationUseCase } from './use-cases/confirm-reservation'
import { ReleaseReservationUseCase } from './use-cases/release-reservation'
import { ReserveStockUseCase } from './use-cases/reserve-stock'

export class InventorySalesEventHandlers {
  readonly handlers: Readonly<Record<string, EventHandler>>
  private readonly reserve: ReserveStockUseCase
  private readonly confirm: ConfirmReservationUseCase
  private readonly release: ReleaseReservationUseCase

  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    clock: Clock,
    reservationTtlSeconds: number,
  ) {
    this.reserve = new ReserveStockUseCase(unitOfWork, clock, reservationTtlSeconds)
    this.confirm = new ConfirmReservationUseCase(unitOfWork, clock)
    this.release = new ReleaseReservationUseCase(unitOfWork, clock)
    this.handlers = {
      'sales.order.placed': (event) => this.orderPlaced(event),
      'sales.order.confirmed': (event) => this.orderConfirmed(event),
      'sales.order.cancelled': (event) => this.orderCancelled(event),
    }
  }

  private async orderPlaced(event: EventEnvelope): Promise<void> {
    const parsed = salesOrderPlaced.envelope.parse(event)
    const outcome = await this.unitOfWork.processEvent(parsed.tenantId, received(parsed), (scope) =>
      this.reserve.executeInScope(scope, {
        tenantId: parsed.tenantId,
        orderId: parsed.payload.orderId,
        orderVersion: parsed.payload.orderVersion,
        fulfillmentWarehouseId: parsed.payload.fulfillmentWarehouseId,
        lines: parsed.payload.lines,
      }),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }

  private async orderConfirmed(event: EventEnvelope): Promise<void> {
    const parsed = salesOrderConfirmed.envelope.parse(event)
    const outcome = await this.unitOfWork.processEvent(parsed.tenantId, received(parsed), (scope) =>
      this.confirm.executeInScope(scope, {
        tenantId: parsed.tenantId,
        orderId: parsed.payload.orderId,
        orderVersion: parsed.payload.orderVersion,
        reservationId: parsed.payload.reservationId,
      }),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }

  private async orderCancelled(event: EventEnvelope): Promise<void> {
    const parsed = salesOrderCancelled.envelope.parse(event)
    const outcome = await this.unitOfWork.processEvent(parsed.tenantId, received(parsed), (scope) =>
      this.release.executeInScope(scope, {
        tenantId: parsed.tenantId,
        orderId: parsed.payload.orderId,
        orderVersion: parsed.payload.orderVersion,
        reason: 'cancelled',
      }),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }
}

function received(event: EventEnvelope) {
  return { sourceModule: 'sales', eventId: event.eventId, eventType: event.eventType }
}
