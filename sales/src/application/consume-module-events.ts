import {
  catalogItemCreated,
  catalogItemDeactivated,
  catalogPriceChanged,
  type EventEnvelope,
  inventoryStockReservationRejected,
  inventoryStockReserved,
} from '@horizon/contracts'
import { Currency, LineDescription, Money } from '@/domain/value-objects/sales-values'
import type { EventHandler } from '@/infrastructure/messaging/rabbitmq-transport'
import type { Clock } from './ports/clock'
import type { SalesUnitOfWork } from './ports/unit-of-work'
import {
  ApplyStockReservationRejectedUseCase,
  ApplyStockReservedUseCase,
} from './use-cases/apply-reservation-outcome'

export class SalesModuleEventHandlers {
  readonly handlers: Readonly<Record<string, EventHandler>>
  private readonly reserved: ApplyStockReservedUseCase
  private readonly rejected: ApplyStockReservationRejectedUseCase

  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    clock: Clock,
  ) {
    this.reserved = new ApplyStockReservedUseCase(unitOfWork, clock)
    this.rejected = new ApplyStockReservationRejectedUseCase(unitOfWork, clock)
    this.handlers = {
      'catalog.item.created': (event) => this.itemCreated(event),
      'catalog.item.deactivated': (event) => this.itemDeactivated(event),
      'catalog.price.changed': (event) => this.priceChanged(event),
      'inventory.stock.reserved': (event) => this.stockReserved(event),
      'inventory.stock.reservation-rejected': (event) => this.stockRejected(event),
    }
  }

  private async itemCreated(event: EventEnvelope): Promise<void> {
    const parsed = catalogItemCreated.envelope.parse(event)
    const description = LineDescription.create(parsed.payload.name)
    if (description.isLeft()) throw description.value
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'catalog'), (scope) =>
      scope.catalogItems.recordItem({
        tenantId: parsed.tenantId,
        itemId: parsed.payload.itemId,
        description: description.value,
      }),
    )
  }

  private async itemDeactivated(event: EventEnvelope): Promise<void> {
    const parsed = catalogItemDeactivated.envelope.parse(event)
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'catalog'), (scope) =>
      scope.catalogItems.deactivate(parsed.payload.itemId),
    )
  }

  private async priceChanged(event: EventEnvelope): Promise<void> {
    const parsed = catalogPriceChanged.envelope.parse(event)
    const currency = Currency.create(parsed.payload.currency)
    if (currency.isLeft()) throw currency.value
    const price = Money.create(parsed.payload.amount, currency.value)
    if (price.isLeft()) throw price.value
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'catalog'), (scope) =>
      scope.catalogItems.recordPrice(parsed.payload.itemId, price.value),
    )
  }

  private async stockReserved(event: EventEnvelope): Promise<void> {
    const parsed = inventoryStockReserved.envelope.parse(event)
    const outcome = await this.unitOfWork.processEvent(
      parsed.tenantId,
      received(parsed, 'inventory'),
      (scope) =>
        this.reserved.executeInScope(scope, {
          tenantId: parsed.tenantId,
          orderId: parsed.payload.orderId,
          orderVersion: parsed.payload.orderVersion,
          reservationId: parsed.payload.reservationId,
        }),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }

  private async stockRejected(event: EventEnvelope): Promise<void> {
    const parsed = inventoryStockReservationRejected.envelope.parse(event)
    const outcome = await this.unitOfWork.processEvent(
      parsed.tenantId,
      received(parsed, 'inventory'),
      (scope) =>
        this.rejected.executeInScope(scope, {
          tenantId: parsed.tenantId,
          orderId: parsed.payload.orderId,
          orderVersion: parsed.payload.orderVersion,
        }),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }
}

function received(event: EventEnvelope, sourceModule: 'catalog' | 'inventory') {
  return { sourceModule, eventId: event.eventId, eventType: event.eventType }
}
