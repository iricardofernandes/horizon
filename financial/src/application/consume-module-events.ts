import {
  type EventEnvelope,
  partyErased,
  partyRegistered,
  partyUpdated,
  procurementOrderApproved,
  procurementOrderCancelled,
  procurementOrderClosed,
  procurementReceiptRecorded,
  procurementReceiptReturned,
  salesOrderCancelled,
  salesOrderConfirmed,
  salesShipmentDispatched,
  salesShipmentReturned,
} from '@horizon/contracts'
import type { EventHandler } from '@/infrastructure/messaging/rabbitmq-transport'
import type { Clock } from './ports/clock'
import type { FinancialUnitOfWork, ReceivedEvent } from './ports/unit-of-work'
import {
  RaisePayableForecastUseCase,
  RecordPayableFromReceiptUseCase,
  WithdrawPayableForecastUseCase,
  WithdrawPayableOfReceiptUseCase,
} from './use-cases/follow-purchasing'
import {
  RaiseReceivableFromOrderUseCase,
  RecordReceivableFromShipmentUseCase,
  WithdrawReceivableOfOrderUseCase,
  WithdrawReceivableOfShipmentUseCase,
} from './use-cases/follow-sales-and-parties'

type SourceModule = 'parties' | 'sales' | 'procurement'

export class FinancialModuleEventHandlers {
  readonly handlers: Readonly<Record<string, EventHandler>>
  private readonly raise: RaiseReceivableFromOrderUseCase
  private readonly receivableFromShipment: RecordReceivableFromShipmentUseCase
  private readonly withdrawShipmentReceivable: WithdrawReceivableOfShipmentUseCase
  private readonly withdraw: WithdrawReceivableOfOrderUseCase
  private readonly forecastPayable: RaisePayableForecastUseCase
  private readonly payableFromReceipt: RecordPayableFromReceiptUseCase
  private readonly withdrawReceiptPayable: WithdrawPayableOfReceiptUseCase
  private readonly withdrawForecast: WithdrawPayableForecastUseCase

  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {
    this.raise = new RaiseReceivableFromOrderUseCase(clock)
    this.receivableFromShipment = new RecordReceivableFromShipmentUseCase(clock)
    this.withdrawShipmentReceivable = new WithdrawReceivableOfShipmentUseCase(clock)
    this.withdraw = new WithdrawReceivableOfOrderUseCase(clock)
    this.forecastPayable = new RaisePayableForecastUseCase(clock)
    this.payableFromReceipt = new RecordPayableFromReceiptUseCase(clock)
    this.withdrawReceiptPayable = new WithdrawPayableOfReceiptUseCase(clock)
    this.withdrawForecast = new WithdrawPayableForecastUseCase(clock)
    this.handlers = {
      'parties.party.registered': (event) => this.partyRegistered(event),
      'parties.party.updated': (event) => this.partyUpdated(event),
      'parties.party.erased': (event) => this.partyErased(event),
      'sales.order.confirmed': (event) => this.orderConfirmed(event),
      'sales.order.cancelled': (event) => this.orderCancelled(event),
      'sales.shipment.dispatched': (event) => this.shipmentDispatched(event),
      'sales.shipment.returned': (event) => this.shipmentReturned(event),
      'procurement.order.approved': (event) => this.purchaseApproved(event),
      'procurement.order.cancelled': (event) => this.purchaseWithdrawn(event, 'cancelled'),
      'procurement.order.closed': (event) => this.purchaseWithdrawn(event, 'closed'),
      'procurement.receipt.recorded': (event) => this.goodsReceived(event),
      'procurement.receipt.returned': (event) => this.goodsReturned(event),
    }
  }

  private async partyRegistered(event: EventEnvelope): Promise<void> {
    const parsed = partyRegistered.envelope.parse(event)
    const { partyId, legalName, roles } = parsed.payload
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'parties'), (scope) =>
      scope.parties.record({ partyId, legalName, roles, active: true }, this.clock.now()),
    )
  }

  private async partyUpdated(event: EventEnvelope): Promise<void> {
    const parsed = partyUpdated.envelope.parse(event)
    const { partyId, legalName, roles, active } = parsed.payload
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'parties'), (scope) =>
      scope.parties.record({ partyId, legalName, roles, active }, this.clock.now()),
    )
  }

  private async partyErased(event: EventEnvelope): Promise<void> {
    const parsed = partyErased.envelope.parse(event)
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'parties'), (scope) =>
      scope.parties.forget(parsed.payload.partyId, this.clock.now()),
    )
  }

  private async orderConfirmed(event: EventEnvelope): Promise<void> {
    const parsed = salesOrderConfirmed.envelope.parse(event)
    const outcome = await this.unitOfWork.processEvent(
      parsed.tenantId,
      received(parsed, 'sales'),
      (scope) => this.raise.executeInScope(scope, parsed.payload),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }

  /** Goods left: what they carried is owed, and the order expects only what is left. */
  private async shipmentDispatched(event: EventEnvelope): Promise<void> {
    const parsed = salesShipmentDispatched.envelope.parse(event)
    const outcome = await this.unitOfWork.processEvent(
      parsed.tenantId,
      received(parsed, 'sales'),
      (scope) => this.receivableFromShipment.executeInScope(scope, parsed.payload),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }

  /** The delivery came back: what it made owed goes with it, and the order expects it again. */
  private async shipmentReturned(event: EventEnvelope): Promise<void> {
    const parsed = salesShipmentReturned.envelope.parse(event)
    const outcome = await this.unitOfWork.processEvent(
      parsed.tenantId,
      received(parsed, 'sales'),
      (scope) => this.withdrawShipmentReceivable.executeInScope(scope, parsed.payload),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }

  private async orderCancelled(event: EventEnvelope): Promise<void> {
    const parsed = salesOrderCancelled.envelope.parse(event)
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'sales'), (scope) =>
      this.withdraw.executeInScope(scope, parsed.payload.orderId),
    )
  }

  private async purchaseApproved(event: EventEnvelope): Promise<void> {
    const parsed = procurementOrderApproved.envelope.parse(event)
    const { payload } = parsed
    const outcome = await this.unitOfWork.processEvent(
      parsed.tenantId,
      received(parsed, 'procurement'),
      (scope) =>
        this.forecastPayable.executeInScope(scope, {
          orderId: payload.orderId,
          supplierId: payload.supplierId,
          issuedOn: payload.issuedOn,
          total: payload.total,
          installments: payload.installments,
        }),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }

  private async purchaseWithdrawn(
    event: EventEnvelope,
    why: 'cancelled' | 'closed',
  ): Promise<void> {
    const definition = why === 'cancelled' ? procurementOrderCancelled : procurementOrderClosed
    const parsed = definition.envelope.parse(event)
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'procurement'), (scope) =>
      this.withdrawForecast.executeInScope(
        scope,
        parsed.payload.orderId,
        why === 'cancelled'
          ? 'The purchase order was cancelled'
          : 'Nothing more is expected against this purchase order',
      ),
    )
  }

  private async goodsReceived(event: EventEnvelope): Promise<void> {
    const parsed = procurementReceiptRecorded.envelope.parse(event)
    const { payload } = parsed
    const outcome = await this.unitOfWork.processEvent(
      parsed.tenantId,
      received(parsed, 'procurement'),
      (scope) =>
        this.payableFromReceipt.executeInScope(scope, {
          orderId: payload.orderId,
          receiptId: payload.receiptId,
          supplierId: payload.supplierId,
          receivedOn: payload.receivedOn,
          value: payload.value,
          installments: payload.installments,
          remaining: payload.remaining,
          remainingInstallments: payload.remainingInstallments,
        }),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }

  private async goodsReturned(event: EventEnvelope): Promise<void> {
    const parsed = procurementReceiptReturned.envelope.parse(event)
    const { payload } = parsed
    const outcome = await this.unitOfWork.processEvent(
      parsed.tenantId,
      received(parsed, 'procurement'),
      (scope) =>
        this.withdrawReceiptPayable.executeInScope(scope, {
          orderId: payload.orderId,
          receiptId: payload.receiptId,
          remaining: payload.remaining,
          remainingInstallments: payload.remainingInstallments,
        }),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }
}

function received(event: EventEnvelope, sourceModule: SourceModule): ReceivedEvent {
  return { sourceModule, eventId: event.eventId, eventType: event.eventType }
}
