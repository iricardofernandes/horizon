import {
  catalogItemCreated,
  catalogItemDeactivated,
  type EventEnvelope,
  partyErased,
  partyRegistered,
  partyUpdated,
} from '@horizon/contracts'
import { LineDescription } from '@/domain/value-objects/procurement-values'
import type { EventHandler } from '@/infrastructure/messaging/rabbitmq-transport'
import type { Clock } from './ports/clock'
import type { ProcurementUnitOfWork } from './ports/unit-of-work'
import {
  ForgetPartyUseCase,
  type PartyState,
  ProjectPartyUseCase,
} from './use-cases/project-parties'

type SourceModule = 'catalog' | 'parties'

/**
 * What Procurement learns from elsewhere: who may be bought from, and what may be bought.
 *
 * Both are projections and neither is authoritative here — the registry owns the supplier
 * and the catalogue owns the item. Procurement keeps only what writing an order needs, and
 * copies it onto the order the moment one is written.
 */
export class ProcurementModuleEventHandlers {
  readonly handlers: Readonly<Record<string, EventHandler>>
  private readonly projectParty: ProjectPartyUseCase
  private readonly forgetParty: ForgetPartyUseCase

  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    clock: Clock,
  ) {
    this.projectParty = new ProjectPartyUseCase(clock)
    this.forgetParty = new ForgetPartyUseCase(clock)
    this.handlers = {
      'catalog.item.created': (event) => this.itemCreated(event),
      'catalog.item.deactivated': (event) => this.itemDeactivated(event),
      'parties.party.registered': (event) => this.partyRegistered(event),
      'parties.party.updated': (event) => this.partyUpdated(event),
      'parties.party.erased': (event) => this.partyErased(event),
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
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'parties'), (scope) =>
      this.forgetParty.executeInScope(scope, parsed.payload.partyId),
    )
  }

  private async project(
    envelope: EventEnvelope,
    payload: Omit<PartyState, 'tenantId'>,
  ): Promise<void> {
    const outcome = await this.unitOfWork.processEvent(
      envelope.tenantId,
      received(envelope, 'parties'),
      (scope) =>
        this.projectParty.executeInScope(scope, { ...payload, tenantId: envelope.tenantId }),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }
}

function received(event: EventEnvelope, sourceModule: SourceModule) {
  return { sourceModule, eventId: event.eventId, eventType: event.eventType }
}
