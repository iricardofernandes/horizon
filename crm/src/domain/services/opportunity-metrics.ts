import {
  applyFact,
  type OpportunityState,
  type OpportunityStatus,
  type RecordedFact,
} from '../entities/opportunity'

/** What the opportunity looked like from one fact until the next (Phase 59). */
export interface MetricState {
  readonly sequence: number
  readonly validFrom: Date
  /** `null` while it is still the latest state. */
  readonly validTo: Date | null
  readonly pipelineId: string
  readonly stageId: string
  readonly probabilityBps: number
  readonly ownerId: string
  readonly sourceId: string | null
  readonly amount: string
  readonly currency: string
  readonly expectedCloseOn: string
  readonly status: OpportunityStatus
  readonly closedOn: string | null
}

export type VisitExit = 'moved' | 'won' | 'lost'

/** One stay in a stage: from the fact that brought it there to the one that took it out. */
export interface StageVisit {
  readonly enteredSequence: number
  readonly pipelineId: string
  readonly stageId: string
  readonly enteredAt: Date
  readonly leftAt: Date | null
  readonly exit: VisitExit | null
  readonly toStageId: string | null
}

/** A win or a loss, until a reopening (or a conversion of a loss) supersedes it. */
export interface Closure {
  readonly sequence: number
  readonly outcome: 'won' | 'lost'
  readonly recordedAt: Date
  readonly closedOn: string
  readonly pipelineId: string
  readonly stageId: string
  readonly ownerId: string
  readonly sourceId: string | null
  readonly lossReasonId: string | null
  readonly supersededAt: Date | null
}

export interface MetricRows {
  readonly states: readonly MetricState[]
  readonly visits: readonly StageVisit[]
  readonly closures: readonly Closure[]
}

function stateRow(sequence: number, at: Date, state: OpportunityState): MetricState {
  return {
    sequence,
    validFrom: at,
    validTo: null,
    pipelineId: state.pipelineId,
    stageId: state.stageId,
    probabilityBps: state.probabilityBps,
    ownerId: state.ownerId,
    sourceId: state.sourceId,
    amount: state.expectedValue.amount,
    currency: state.expectedValue.currency,
    expectedCloseOn: state.expectedCloseOn,
    status: state.status,
    closedOn: state.closedOn,
  }
}

/**
 * Everything the forecast and the pipeline metrics read about one opportunity, derived from
 * its history alone (Phase 59). The live projection and a rebuild both call this, so they
 * can only differ if stored rows were changed by something else.
 */
export function metricRowsOf(history: readonly RecordedFact[]): MetricRows {
  const ordered = [...history].sort((a, b) => a.sequence - b.sequence)
  const states: MetricState[] = []
  const visits: StageVisit[] = []
  const closures: Closure[] = []
  let state: OpportunityState | null = null
  let visit: StageVisit | null = null

  const leave = (at: Date, exit: VisitExit, toStageId: string | null = null) => {
    if (!visit) return
    visits.push({ ...visit, leftAt: at, exit, toStageId })
    visit = null
  }
  const enter = (sequence: number, at: Date, after: OpportunityState) => {
    visit = {
      enteredSequence: sequence,
      pipelineId: after.pipelineId,
      stageId: after.stageId,
      enteredAt: at,
      leftAt: null,
      exit: null,
      toStageId: null,
    }
  }
  const supersede = (at: Date) => {
    const index = closures.findLastIndex((closure) => closure.supersededAt === null)
    const current = closures[index]
    if (current) closures[index] = { ...current, supersededAt: at }
  }
  const close = (sequence: number, at: Date, after: OpportunityState, outcome: 'won' | 'lost') =>
    closures.push({
      sequence,
      outcome,
      recordedAt: at,
      closedOn: after.closedOn ?? '',
      pipelineId: after.pipelineId,
      stageId: after.stageId,
      ownerId: after.ownerId,
      sourceId: after.sourceId,
      lossReasonId: after.lossReasonId,
      supersededAt: null,
    })

  for (const recorded of ordered) {
    const before: OpportunityState | null = state
    const after = applyFact(before, recorded)
    const { fact, sequence, occurredAt: at } = recorded
    const previous = states.at(-1)
    if (previous) states[states.length - 1] = { ...previous, validTo: at }
    states.push(stateRow(sequence, at, after))

    switch (fact.type) {
      case 'created':
      case 'reopened':
        if (fact.type === 'reopened') supersede(at)
        enter(sequence, at, after)
        break
      case 'stage-changed':
        leave(at, 'moved', fact.toStageId)
        enter(sequence, at, after)
        break
      case 'won':
      case 'lost':
        leave(at, fact.type)
        close(sequence, at, after, fact.type)
        break
      case 'converted':
        // Won by hand already: that closure stands. Otherwise this is the win.
        if (before?.status === 'won') break
        if (before?.status === 'lost') supersede(at)
        leave(at, 'won')
        close(sequence, at, after, 'won')
        break
      default:
        break
    }
    state = after
  }
  if (visit) visits.push(visit)
  return { states, visits, closures }
}
