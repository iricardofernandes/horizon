import {
  type EventEnvelope,
  procurementReceiptRecorded,
  procurementReceiptReturned,
} from '@horizon/contracts'
import type { EventHandler } from '@/infrastructure/messaging/rabbitmq-transport'
import type { Clock } from './ports/clock'
import type { InventoryUnitOfWork } from './ports/unit-of-work'
import {
  ReceivePurchasedGoodsUseCase,
  ReturnPurchasedGoodsUseCase,
} from './use-cases/receive-purchases'

/**
 * What purchasing delivers, and what goes back.
 *
 * Stock and the payable both follow from the same receipt event, so the goods on the shelf
 * and the money owed for them can never disagree about what arrived. The inbox key is the
 * event id, so a redelivery moves stock once.
 */
export class InventoryProcurementEventHandlers {
  readonly handlers: Readonly<Record<string, EventHandler>>
  private readonly receive: ReceivePurchasedGoodsUseCase
  private readonly giveBack: ReturnPurchasedGoodsUseCase

  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    clock: Clock,
  ) {
    this.receive = new ReceivePurchasedGoodsUseCase(clock)
    this.giveBack = new ReturnPurchasedGoodsUseCase(clock)
    this.handlers = {
      'procurement.receipt.recorded': (event) => this.receiptRecorded(event),
      'procurement.receipt.returned': (event) => this.receiptReturned(event),
    }
  }

  private async receiptRecorded(event: EventEnvelope): Promise<void> {
    const parsed = procurementReceiptRecorded.envelope.parse(event)
    const outcome = await this.unitOfWork.processEvent(parsed.tenantId, received(parsed), (scope) =>
      this.receive.executeInScope(scope, {
        tenantId: parsed.tenantId,
        warehouseId: parsed.payload.warehouseId,
        // The receipt is what a recall is traced back to, so the movement names it.
        receiptId: parsed.payload.receiptId,
        lines: parsed.payload.lines,
      }),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }

  private async receiptReturned(event: EventEnvelope): Promise<void> {
    const parsed = procurementReceiptReturned.envelope.parse(event)
    const outcome = await this.unitOfWork.processEvent(parsed.tenantId, received(parsed), (scope) =>
      this.giveBack.executeInScope(scope, {
        tenantId: parsed.tenantId,
        warehouseId: parsed.payload.warehouseId,
        receiptId: parsed.payload.receiptId,
        lines: parsed.payload.lines,
      }),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }
}

function received(event: EventEnvelope) {
  return { sourceModule: 'procurement', eventId: event.eventId, eventType: event.eventType }
}
