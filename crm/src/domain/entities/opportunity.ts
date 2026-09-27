import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { OpportunityPublished } from '../events/opportunity-events'
import type { BusinessDate, Money, OpportunityTitle } from '../value-objects/crm-values'
import type { Stage } from './pipeline'

export type OpportunityStatus = 'open' | 'won' | 'lost'

interface Amount {
  readonly amount: string
  readonly currency: string
}

/**
 * Everything that ever happened to an opportunity, in the order it happened (Phase 56).
 * The history keeps the title and contacts so it can rebuild the whole record; what is
 * published outside CRM never includes them.
 */
export type OpportunityFact =
  | {
      readonly type: 'created'
      readonly accountId: string
      readonly title: string
      readonly contactIds: readonly string[]
      readonly ownerId: string
      readonly sourceId: string | null
      readonly expectedValue: Amount
      readonly expectedCloseOn: string
      readonly pipelineId: string
      readonly stageId: string
      readonly probabilityBps: number
    }
  | {
      readonly type: 'revised'
      readonly title: string
      readonly contactIds: readonly string[]
      readonly sourceId: string | null
      readonly expectedValue: Amount
      readonly expectedCloseOn: string
    }
  | {
      readonly type: 'stage-changed'
      readonly fromStageId: string
      readonly toStageId: string
      readonly probabilityBps: number
    }
  | { readonly type: 'owner-changed'; readonly fromOwnerId: string; readonly toOwnerId: string }
  | { readonly type: 'won'; readonly closedOn: string }
  | {
      readonly type: 'lost'
      readonly closedOn: string
      readonly lossReasonId: string
      readonly note: string | null
    }
  | {
      readonly type: 'reopened'
      readonly previousStatus: 'won' | 'lost'
      readonly stageId: string
      readonly probabilityBps: number
    }

export interface RecordedFact {
  readonly sequence: number
  readonly fact: OpportunityFact
  readonly actor: string
  readonly occurredAt: Date
}

/** The fold of an opportunity's history: what the `opportunities` row holds. */
export interface OpportunityState {
  readonly accountId: string
  readonly title: string
  readonly contactIds: readonly string[]
  readonly ownerId: string
  readonly sourceId: string | null
  readonly expectedValue: Amount
  readonly expectedCloseOn: string
  readonly pipelineId: string
  readonly stageId: string
  readonly probabilityBps: number
  readonly status: OpportunityStatus
  readonly lossReasonId: string | null
  readonly lossNote: string | null
  readonly closedOn: string | null
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** Apply one fact. The only place the state of an opportunity changes. */
export function applyFact(
  state: OpportunityState | null,
  { fact, sequence, occurredAt }: RecordedFact,
): OpportunityState {
  if (fact.type === 'created') {
    if (state) throw new Error('an opportunity is created once')
    const { type: _, ...opened } = fact
    return {
      ...opened,
      contactIds: [...fact.contactIds],
      status: 'open',
      lossReasonId: null,
      lossNote: null,
      closedOn: null,
      version: sequence,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
  }
  if (!state) throw new Error('an opportunity history starts with its creation')
  const next = { ...state, version: sequence, updatedAt: occurredAt }
  switch (fact.type) {
    case 'revised': {
      const { type: _, ...revised } = fact
      return { ...next, ...revised, contactIds: [...fact.contactIds] }
    }
    case 'stage-changed':
      return { ...next, stageId: fact.toStageId, probabilityBps: fact.probabilityBps }
    case 'owner-changed':
      return { ...next, ownerId: fact.toOwnerId }
    case 'won':
      return { ...next, status: 'won', closedOn: fact.closedOn }
    case 'lost':
      return {
        ...next,
        status: 'lost',
        closedOn: fact.closedOn,
        lossReasonId: fact.lossReasonId,
        lossNote: fact.note,
      }
    case 'reopened':
      return {
        ...next,
        status: 'open',
        stageId: fact.stageId,
        probabilityBps: fact.probabilityBps,
        closedOn: null,
        lossReasonId: null,
        lossNote: null,
      }
  }
}

/** Rebuild an opportunity's state from its full history, in order. */
export function foldHistory(history: readonly RecordedFact[]): OpportunityState {
  const ordered = [...history].sort((a, b) => a.sequence - b.sequence)
  ordered.forEach((recorded, index) => {
    if (recorded.sequence !== index + 1) throw new Error('an opportunity history has a gap')
  })
  const state = ordered.reduce<OpportunityState | null>(applyFact, null)
  if (!state) throw new Error('an empty history is not an opportunity')
  return state
}

export interface OpportunitySnapshot extends OpportunityState {
  readonly id: string
  readonly tenantId: string
}

type Refusal = Either<ConflictError, void>

/**
 * A sale being pursued: an account, what it is worth, when it should close, who looks
 * after it and where it stands in a pipeline.
 *
 * Commands decide which fact happens and apply it; nothing else changes the state. The
 * pending facts are what the repository appends to the history, and the publishable ones
 * leave through the outbox as `crm.opportunity.*` — without the title or the contacts.
 */
export class Opportunity extends AggregateRoot<{ tenantId: string; state: OpportunityState }> {
  private pending: RecordedFact[] = []

  static open(
    props: {
      tenantId: string
      accountId: string
      title: OpportunityTitle
      contactIds: readonly string[]
      ownerId: string
      sourceId: string | null
      expectedValue: Money
      expectedCloseOn: BusinessDate
      pipelineId: string
      stage: Stage
      actor: string
      now: Date
    },
    id: UniqueEntityID,
  ): Opportunity {
    const fact: OpportunityFact = {
      type: 'created',
      accountId: props.accountId,
      title: props.title.value,
      contactIds: [...new Set(props.contactIds)],
      ownerId: props.ownerId,
      sourceId: props.sourceId,
      expectedValue: props.expectedValue.toJSON(),
      expectedCloseOn: props.expectedCloseOn.value,
      pipelineId: props.pipelineId,
      stageId: props.stage.id,
      probabilityBps: props.stage.probability.bps,
    }
    const recorded = { sequence: 1, fact, actor: props.actor, occurredAt: props.now }
    const opportunity = new Opportunity(
      { tenantId: props.tenantId, state: applyFact(null, recorded) },
      id,
    )
    opportunity.pending.push(recorded)
    opportunity.publish(recorded, null)
    return opportunity
  }

  static rehydrate(tenantId: string, state: OpportunityState, id: UniqueEntityID): Opportunity {
    return new Opportunity({ tenantId, state }, id)
  }

  get state(): OpportunityState {
    return this.props.state
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  /** Facts decided since the opportunity was loaded, for the history; cleared when read. */
  pullRecordedFacts(): readonly RecordedFact[] {
    const facts = this.pending
    this.pending = []
    return facts
  }

  revise(
    change: {
      title: OpportunityTitle
      contactIds: readonly string[]
      sourceId: string | null
      expectedValue: Money
      expectedCloseOn: BusinessDate
    },
    actor: string,
    now: Date,
  ): Either<ConflictError, boolean> {
    const open = this.requireOpen()
    if (open.isLeft()) return left(open.value)
    const current = this.props.state
    const fact: OpportunityFact = {
      type: 'revised',
      title: change.title.value,
      contactIds: [...new Set(change.contactIds)],
      sourceId: change.sourceId,
      expectedValue: change.expectedValue.toJSON(),
      expectedCloseOn: change.expectedCloseOn.value,
    }
    const unchanged =
      fact.title === current.title &&
      sameIds(fact.contactIds, current.contactIds) &&
      fact.sourceId === current.sourceId &&
      sameAmount(fact.expectedValue, current.expectedValue) &&
      fact.expectedCloseOn === current.expectedCloseOn
    if (unchanged) return right(false)
    this.record(fact, actor, now)
    return right(true)
  }

  move(stage: Stage, actor: string, now: Date): Refusal {
    const open = this.requireOpen()
    if (open.isLeft()) return open
    if (stage.id === this.props.state.stageId)
      return left(new ConflictError('the opportunity is already in this stage'))
    this.record(
      {
        type: 'stage-changed',
        fromStageId: this.props.state.stageId,
        toStageId: stage.id,
        probabilityBps: stage.probability.bps,
      },
      actor,
      now,
    )
    return right(undefined)
  }

  reassign(ownerId: string, actor: string, now: Date): Refusal {
    const open = this.requireOpen()
    if (open.isLeft()) return open
    if (ownerId === this.props.state.ownerId)
      return left(new ConflictError('this user already owns the opportunity'))
    this.record(
      { type: 'owner-changed', fromOwnerId: this.props.state.ownerId, toOwnerId: ownerId },
      actor,
      now,
    )
    return right(undefined)
  }

  win(closedOn: BusinessDate, actor: string, now: Date): Refusal {
    const open = this.requireOpen()
    if (open.isLeft()) return open
    this.record({ type: 'won', closedOn: closedOn.value }, actor, now)
    return right(undefined)
  }

  lose(
    lossReasonId: string,
    note: string | null,
    closedOn: BusinessDate,
    actor: string,
    now: Date,
  ): Refusal {
    const open = this.requireOpen()
    if (open.isLeft()) return open
    this.record({ type: 'lost', closedOn: closedOn.value, lossReasonId, note }, actor, now)
    return right(undefined)
  }

  /** A closed opportunity opens again; both closures stay in its history. */
  reopen(stage: Stage, actor: string, now: Date): Refusal {
    const status = this.props.state.status
    if (status === 'open') return left(new ConflictError('the opportunity is already open'))
    this.record(
      {
        type: 'reopened',
        previousStatus: status,
        stageId: stage.id,
        probabilityBps: stage.probability.bps,
      },
      actor,
      now,
    )
    return right(undefined)
  }

  toSnapshot(): Readonly<OpportunitySnapshot> {
    return Object.freeze({
      ...this.props.state,
      id: this.id.toString(),
      tenantId: this.props.tenantId,
    })
  }

  private requireOpen(): Refusal {
    return this.props.state.status === 'open'
      ? right(undefined)
      : left(new ConflictError(`the opportunity is ${this.props.state.status}`))
  }

  private record(fact: OpportunityFact, actor: string, now: Date): void {
    const previous = this.props.state
    const recorded = { sequence: previous.version + 1, fact, actor, occurredAt: now }
    this.props.state = applyFact(previous, recorded)
    this.pending.push(recorded)
    this.publish(recorded, previous)
  }

  /**
   * Every fact is published but a revision that touched only the title or the contacts:
   * that is history, not news — a forecast reads the value, the close date and the source.
   */
  private publish(recorded: RecordedFact, previous: OpportunityState | null): void {
    const now = this.props.state
    if (
      recorded.fact.type === 'revised' &&
      previous &&
      previous.sourceId === now.sourceId &&
      sameAmount(previous.expectedValue, now.expectedValue) &&
      previous.expectedCloseOn === now.expectedCloseOn
    )
      return
    this.addDomainEvent(
      new OpportunityPublished(
        this.id,
        this.props.tenantId,
        recorded.fact,
        now,
        recorded.occurredAt,
      ),
    )
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join()
}

function sameAmount(a: Amount, b: Amount): boolean {
  return a.amount === b.amount && a.currency === b.currency
}
