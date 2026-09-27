import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import type { OpportunityFact, OpportunityState } from '../entities/opportunity'

/**
 * One opportunity fact as the rest of Horizon reads it: `crm.opportunity.<fact>` v1.
 *
 * Built from the fact and the state right after it, so each event carries what a
 * forecast or a conversion metric needs at that moment. The title and the contacts never
 * leave CRM (ADR 0057).
 */
export class OpportunityPublished implements DomainEvent {
  readonly eventType: string
  readonly eventVersion = 1

  constructor(
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    private readonly fact: OpportunityFact,
    private readonly state: OpportunityState,
    readonly occurredAt: Date,
  ) {
    this.eventType = `crm.opportunity.${fact.type}`
  }

  payloadOf(): Readonly<Record<string, unknown>> {
    const { fact, state } = this
    const about = { opportunityId: this.aggregateId.toString(), accountId: state.accountId }
    const closure = {
      ...about,
      pipelineId: state.pipelineId,
      stageId: state.stageId,
      ownerId: state.ownerId,
      sourceId: state.sourceId,
      value: { ...state.expectedValue },
      closedOn: state.closedOn,
    }
    switch (fact.type) {
      case 'created':
        return {
          ...about,
          pipelineId: state.pipelineId,
          stageId: state.stageId,
          probabilityBps: state.probabilityBps,
          ownerId: state.ownerId,
          sourceId: state.sourceId,
          expectedValue: { ...state.expectedValue },
          expectedCloseOn: state.expectedCloseOn,
        }
      case 'revised':
        return {
          ...about,
          sourceId: state.sourceId,
          expectedValue: { ...state.expectedValue },
          expectedCloseOn: state.expectedCloseOn,
        }
      case 'stage-changed':
        return {
          ...about,
          pipelineId: state.pipelineId,
          fromStageId: fact.fromStageId,
          toStageId: fact.toStageId,
          probabilityBps: fact.probabilityBps,
        }
      case 'owner-changed':
        return { ...about, fromOwnerId: fact.fromOwnerId, toOwnerId: fact.toOwnerId }
      case 'won':
        return closure
      case 'lost':
        return { ...closure, lossReasonId: fact.lossReasonId }
      case 'converted':
        return {
          ...about,
          quoteId: fact.quote.quoteId,
          quoteRoot: fact.quote.quoteRoot,
          quoteVersion: fact.quote.quoteVersion,
          value: { ...state.expectedValue },
          ownerId: state.ownerId,
          sourceId: state.sourceId,
          closedOn: state.closedOn,
        }
      case 'reopened':
        return {
          ...about,
          pipelineId: state.pipelineId,
          stageId: fact.stageId,
          probabilityBps: fact.probabilityBps,
          previousStatus: fact.previousStatus,
        }
    }
  }
}
