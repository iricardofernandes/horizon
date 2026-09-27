import {
  type EventEnvelope,
  partyErased,
  partyRegistered,
  partyRegisteredV2,
  partyUpdated,
  partyUpdatedV2,
  salesQuoteAccepted,
  salesQuoteRejected,
  salesQuoteSent,
  userDisabled,
  userRegistered,
} from '@horizon/contracts'
import type { PartyFacts } from '@/domain/entities/account'
import type { DocumentType, PartyKind } from '@/domain/value-objects/crm-values'
import type { EventHandler } from '@/infrastructure/messaging/rabbitmq-transport'
import type { Clock } from './ports/clock'
import type { CrmUnitOfWork } from './ports/unit-of-work'
import { FollowQuoteUseCase } from './use-cases/follow-quotes'
import { ForgetPartyUseCase, ProjectPartyUseCase } from './use-cases/project-parties'

type SourceModule = 'parties' | 'identity' | 'sales'

/** A v1 party had a CPF or a CNPJ, which its kind decides (ADR 0040). */
function v1DocumentOf(kind: PartyKind | null): DocumentType | null {
  if (kind === null) return null
  return kind === 'organization' ? 'cnpj' : 'cpf'
}

/**
 * What CRM learns from elsewhere: which parties are accounts, and which users may own
 * them. Both are projections; the registry and Identity stay authoritative.
 */
export class CrmModuleEventHandlers {
  readonly handlers: Readonly<Record<string, EventHandler>>
  private readonly projectParty: ProjectPartyUseCase
  private readonly forgetParty: ForgetPartyUseCase
  private readonly followQuote: FollowQuoteUseCase

  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {
    this.projectParty = new ProjectPartyUseCase(clock)
    this.forgetParty = new ForgetPartyUseCase(clock)
    this.followQuote = new FollowQuoteUseCase(clock)
    this.handlers = {
      'parties.party.registered': (event) => this.partyRegistered(event),
      'parties.party.updated': (event) => this.partyUpdated(event),
      'parties.party.erased': (event) => this.partyErased(event),
      'identity.user.registered': (event) => this.userRegistered(event),
      'identity.user.disabled': (event) => this.userDisabled(event),
      'sales.quote.sent': (event) => this.quote(event),
      'sales.quote.accepted': (event) => this.quote(event),
      'sales.quote.rejected': (event) => this.quote(event),
    }
  }

  private async partyRegistered(event: EventEnvelope): Promise<void> {
    if (event.eventVersion === 2) {
      const { payload, ...envelope } = partyRegisteredV2.envelope.parse(event)
      return this.project(envelope, payload.partyId, { ...payload, active: true })
    }
    const { payload, ...envelope } = partyRegistered.envelope.parse(event)
    return this.project(envelope, payload.partyId, {
      ...payload,
      documentType: v1DocumentOf(payload.kind),
      documentCountry: null,
      active: true,
    })
  }

  /** A v2 update may be a republish for a consumer that missed the registration. */
  private async partyUpdated(event: EventEnvelope): Promise<void> {
    if (event.eventVersion === 2) {
      const { payload, ...envelope } = partyUpdatedV2.envelope.parse(event)
      return this.project(envelope, payload.partyId, { ...payload, kind: payload.kind ?? null })
    }
    const { payload, ...envelope } = partyUpdated.envelope.parse(event)
    return this.project(envelope, payload.partyId, {
      ...payload,
      kind: null,
      documentType: null,
      documentCountry: null,
    })
  }

  private async partyErased(event: EventEnvelope): Promise<void> {
    const parsed = partyErased.envelope.parse(event)
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'parties'), (scope) =>
      this.forgetParty.executeInScope(scope, parsed.payload.partyId),
    )
  }

  private async project(
    envelope: Omit<EventEnvelope, 'payload'>,
    partyId: string,
    facts: PartyFacts & Record<string, unknown>,
  ): Promise<void> {
    const party: PartyFacts = {
      kind: facts.kind,
      legalName: facts.legalName,
      tradeName: facts.tradeName,
      roles: facts.roles,
      documentType: facts.documentType,
      documentCountry: facts.documentCountry,
      active: facts.active,
    }
    await this.unitOfWork.processEvent(envelope.tenantId, received(envelope, 'parties'), (scope) =>
      this.projectParty.executeInScope(scope, { ...party, partyId }),
    )
  }

  /** A quote made for an opportunity links to it; an accepted one converts it (Phase 58). */
  private async quote(event: EventEnvelope): Promise<void> {
    const occurredAt = new Date(event.occurredAt)
    const fact =
      event.eventType === 'sales.quote.rejected'
        ? (({ payload }) => ({ ...payload, status: 'rejected' as const, total: null }))(
            salesQuoteRejected.envelope.parse(event),
          )
        : event.eventType === 'sales.quote.accepted'
          ? (({ payload }) => ({ ...payload, status: 'accepted' as const }))(
              salesQuoteAccepted.envelope.parse(event),
            )
          : (({ payload }) => ({ ...payload, status: 'sent' as const }))(
              salesQuoteSent.envelope.parse(event),
            )
    if (!fact.attribution) return
    await this.unitOfWork.processEvent(event.tenantId, received(event, 'sales'), (scope) =>
      this.followQuote.executeInScope(scope, {
        status: fact.status,
        quoteId: fact.quoteId,
        quoteRoot: fact.quoteRoot,
        quoteVersion: fact.version,
        total: fact.total,
        occurredAt,
        attribution: fact.attribution,
      }),
    )
  }

  private async userRegistered(event: EventEnvelope): Promise<void> {
    const parsed = userRegistered.envelope.parse(event)
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'identity'), (scope) =>
      scope.owners.register(parsed.payload.userId, new Date(parsed.payload.registeredAt)),
    )
  }

  private async userDisabled(event: EventEnvelope): Promise<void> {
    const parsed = userDisabled.envelope.parse(event)
    await this.unitOfWork.processEvent(parsed.tenantId, received(parsed, 'identity'), (scope) =>
      scope.owners.disable(parsed.payload.userId, this.clock.now()),
    )
  }
}

function received(event: Omit<EventEnvelope, 'payload'>, sourceModule: SourceModule) {
  return { sourceModule, eventId: event.eventId, eventType: event.eventType }
}
