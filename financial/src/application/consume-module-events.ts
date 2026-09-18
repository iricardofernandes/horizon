import {
  type EventEnvelope,
  partyErased,
  partyRegistered,
  partyUpdated,
  salesInvoicingRequested,
  salesOrderCancelled,
  salesOrderConfirmed,
} from '@horizon/contracts'
import type { EventHandler } from '@/infrastructure/messaging/rabbitmq-transport'
import type { Clock } from './ports/clock'
import type { FinancialUnitOfWork, ReceivedEvent } from './ports/unit-of-work'
import {
  RaiseReceivableFromOrderUseCase,
  RealiseForecastFromInvoicingUseCase,
  WithdrawReceivableOfOrderUseCase,
} from './use-cases/follow-sales-and-parties'

type SourceModule = 'parties' | 'sales'

export class FinancialModuleEventHandlers {
  readonly handlers: Readonly<Record<string, EventHandler>>
  private readonly raise: RaiseReceivableFromOrderUseCase
  private readonly realise: RealiseForecastFromInvoicingUseCase
  private readonly withdraw: WithdrawReceivableOfOrderUseCase

  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {
    this.raise = new RaiseReceivableFromOrderUseCase(clock)
    this.realise = new RealiseForecastFromInvoicingUseCase(clock)
    this.withdraw = new WithdrawReceivableOfOrderUseCase(clock)
    this.handlers = {
      'parties.party.registered': (event) => this.partyRegistered(event),
      'parties.party.updated': (event) => this.partyUpdated(event),
      'parties.party.erased': (event) => this.partyErased(event),
      'sales.order.confirmed': (event) => this.orderConfirmed(event),
      'sales.order.cancelled': (event) => this.orderCancelled(event),
      'sales.invoicing.requested': (event) => this.invoicingRequested(event),
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

  private async invoicingRequested(event: EventEnvelope): Promise<void> {
    const parsed = salesInvoicingRequested.envelope.parse(event)
    const outcome = await this.unitOfWork.processEvent(
      parsed.tenantId,
      received(parsed, 'sales'),
      (scope) => this.realise.executeInScope(scope, parsed.payload),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }

  private async orderCancelled(event: EventEnvelope): Promise<void> {
    const parsed = salesOrderCancelled.envelope.parse(event)
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'sales'), (scope) =>
      this.withdraw.executeInScope(scope, parsed.payload.orderId),
    )
  }
}

function received(event: EventEnvelope, sourceModule: SourceModule): ReceivedEvent {
  return { sourceModule, eventId: event.eventId, eventType: event.eventType }
}
