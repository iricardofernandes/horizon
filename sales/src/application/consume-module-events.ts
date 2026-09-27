import {
  catalogItemCreated,
  catalogItemDeactivated,
  catalogPriceChanged,
  type EventEnvelope,
  financialReceivablePosted,
  financialReceivableReversed,
  fiscalDocumentProductionOutcome,
  fiscalServiceDocumentOutcome,
  inventoryStockReservationRejected,
  inventoryStockReserved,
  partyErased,
  partyRegistered,
  partyUpdated,
} from '@horizon/contracts'
import { Currency, LineDescription, Money } from '@/domain/value-objects/sales-values'
import type { EventHandler } from '@/infrastructure/messaging/rabbitmq-transport'
import type { Clock } from './ports/clock'
import type { SalesUnitOfWork } from './ports/unit-of-work'
import {
  ApplyStockReservationRejectedUseCase,
  ApplyStockReservedUseCase,
} from './use-cases/apply-reservation-outcome'
import {
  ForgetPartyUseCase,
  type PartyState,
  ProjectPartyUseCase,
} from './use-cases/project-parties'

export class SalesModuleEventHandlers {
  readonly handlers: Readonly<Record<string, EventHandler>>
  private readonly reserved: ApplyStockReservedUseCase
  private readonly rejected: ApplyStockReservationRejectedUseCase
  private readonly projectParty: ProjectPartyUseCase
  private readonly forgetParty: ForgetPartyUseCase

  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    clock: Clock,
    options: { enableProductionReleaseEvents?: boolean } = {},
  ) {
    this.reserved = new ApplyStockReservedUseCase(unitOfWork, clock)
    this.rejected = new ApplyStockReservationRejectedUseCase(unitOfWork, clock)
    this.projectParty = new ProjectPartyUseCase(clock)
    this.forgetParty = new ForgetPartyUseCase(clock)
    this.handlers = {
      'catalog.item.created': (event) => this.itemCreated(event),
      'catalog.item.deactivated': (event) => this.itemDeactivated(event),
      'catalog.price.changed': (event) => this.priceChanged(event),
      'inventory.stock.reserved': (event) => this.stockReserved(event),
      'inventory.stock.reservation-rejected': (event) => this.stockRejected(event),
      'parties.party.registered': (event) => this.partyRegistered(event),
      'parties.party.updated': (event) => this.partyUpdated(event),
      'parties.party.erased': (event) => this.partyErased(event),
      'financial.receivable.posted': (event) => this.receivablePosted(event),
      'financial.receivable.reversed': (event) => this.receivableReversed(event),
      'fiscal.service-document.simulation-outcome': (event) => this.serviceDocumentOutcome(event),
      ...(options.enableProductionReleaseEvents
        ? {
            'fiscal.document.production-outcome': (event: EventEnvelope) =>
              this.productionOutcome(event),
          }
        : {}),
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
        kind: parsed.payload.kind,
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

  /** The receivable a billed period (Phase 52) or a delivery (Phase 53) raised was posted. */
  private async receivablePosted(event: EventEnvelope): Promise<void> {
    const parsed = financialReceivablePosted.envelope.parse(event)
    const { origin, titleId } = parsed.payload
    const at = new Date(parsed.payload.postedAt)
    if (origin.type === 'sales-contract-period')
      await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'financial'), (scope) =>
        scope.billedEffects.receivablePosted(origin.documentId, titleId, at),
      )
    if (origin.type === 'sales-service-delivery')
      await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'financial'), (scope) =>
        scope.billedEffects.deliveryReceivablePosted(origin.documentId, titleId, at),
      )
  }

  /** A receivable was reversed; if a billed period raised it, the period shows it. */
  private async receivableReversed(event: EventEnvelope): Promise<void> {
    const parsed = financialReceivableReversed.envelope.parse(event)
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'financial'), (scope) =>
      scope.billedEffects.receivableReversed(
        parsed.payload.titleId,
        new Date(parsed.payload.reversedAt),
      ),
    )
  }

  /** The NFS-e of a billed contract line or a delivered line was authorized, rejected or cancelled. */
  private async serviceDocumentOutcome(event: EventEnvelope): Promise<void> {
    const parsed = fiscalServiceDocumentOutcome.envelope.parse(event)
    const { payload } = parsed
    const key = payload.sourceKey
    if (key?.module !== 'sales') return
    const at = new Date(payload.observedAt)
    if (key.documentType === 'contract-period')
      await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'fiscal'), (scope) =>
        scope.billedEffects.nfseObserved(key.id, payload.documentId, payload.outcome, at),
      )
    if (key.documentType === 'service-delivery')
      await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'fiscal'), (scope) =>
        scope.billedEffects.deliveryNfseObserved(key.id, payload.documentId, payload.outcome, at),
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
  private async productionOutcome(event: EventEnvelope): Promise<void> {
    const parsed = fiscalDocumentProductionOutcome.envelope.parse(event)
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'fiscal'), (scope) =>
      scope.fiscalDispatchGate.recordOutcome({
        eventId: parsed.eventId,
        shipmentId: parsed.payload.originId,
        originDigest: parsed.payload.originDigest,
        orderVersion: parsed.payload.orderVersion,
        establishmentId: parsed.payload.establishmentId,
        documentId: parsed.payload.documentId,
        documentRevision: parsed.payload.documentRevision,
        environment: parsed.payload.environment,
        outcome: parsed.payload.outcome,
        observedAt: new Date(parsed.payload.observedAt),
      }),
    )
  }

  private async partyRegistered(event: EventEnvelope): Promise<void> {
    const parsed = partyRegistered.envelope.parse(event)
    await this.project(parsed, { ...parsed.payload, active: true })
  }

  private async partyUpdated(event: EventEnvelope): Promise<void> {
    const parsed = partyUpdated.envelope.parse(event)
    await this.project(parsed, parsed.payload)
  }

  private async partyErased(event: EventEnvelope): Promise<void> {
    const parsed = partyErased.envelope.parse(event)
    await this.unitOfWork.provisionTenant(parsed.tenantId)
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'parties'), (scope) =>
      this.forgetParty.executeInScope(scope, parsed.payload.partyId),
    )
  }

  /** A party may be the first thing a workspace ever tells Sales about. */
  private async project(
    envelope: EventEnvelope,
    payload: Omit<PartyState, 'tenantId'>,
  ): Promise<void> {
    await this.unitOfWork.provisionTenant(envelope.tenantId)
    const outcome = await this.unitOfWork.processEvent(
      envelope.tenantId,
      received(envelope, 'parties'),
      (scope) =>
        this.projectParty.executeInScope(scope, { ...payload, tenantId: envelope.tenantId }),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }
}

function received(
  event: EventEnvelope,
  sourceModule: 'catalog' | 'inventory' | 'parties' | 'fiscal' | 'financial',
) {
  return { sourceModule, eventId: event.eventId, eventType: event.eventType }
}
