import { describe, expect, it } from 'vitest'
import type { OpportunityFact, RecordedFact } from '../entities/opportunity'
import { metricRowsOf } from './opportunity-metrics'

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute))
let sequence = 0
const fact = (minute: number, recorded: OpportunityFact): RecordedFact => {
  sequence += 1
  return { sequence, fact: recorded, actor: 'ana', occurredAt: at(minute) }
}

function created(minute: number): RecordedFact {
  sequence = 0
  return fact(minute, {
    type: 'created',
    accountId: 'account',
    title: 'Renovação',
    contactIds: [],
    ownerId: 'owner-1',
    sourceId: 'source-1',
    expectedValue: { amount: '100000', currency: 'BRL' },
    expectedCloseOn: '2026-10-15',
    pipelineId: 'pipeline',
    stageId: 'qualify',
    probabilityBps: 1000,
  })
}

const move = (minute: number, fromStageId: string, toStageId: string, probabilityBps: number) =>
  fact(minute, { type: 'stage-changed', fromStageId, toStageId, probabilityBps })

describe('metric rows of an opportunity history', () => {
  it('follows the stages it visited and closes the last visit with the win', () => {
    const rows = metricRowsOf([
      created(0),
      move(10, 'qualify', 'propose', 5000),
      fact(15, { type: 'owner-changed', fromOwnerId: 'owner-1', toOwnerId: 'owner-2' }),
      move(30, 'propose', 'negotiate', 8000),
      fact(45, { type: 'won', closedOn: '2026-09-01' }),
    ])
    expect(
      rows.visits.map((visit) => [
        visit.stageId,
        visit.enteredAt.getUTCMinutes(),
        visit.exit,
        visit.toStageId,
      ]),
    ).toEqual([
      ['qualify', 0, 'moved', 'propose'],
      ['propose', 10, 'moved', 'negotiate'],
      ['negotiate', 30, 'won', null],
    ])
    expect(
      rows.states.map((state) => [
        state.sequence,
        state.stageId,
        state.ownerId,
        state.validTo?.getUTCMinutes() ?? null,
      ]),
    ).toEqual([
      [1, 'qualify', 'owner-1', 10],
      [2, 'propose', 'owner-1', 15],
      [3, 'propose', 'owner-2', 30],
      [4, 'negotiate', 'owner-2', 45],
      [5, 'negotiate', 'owner-2', null],
    ])
    expect(rows.closures).toEqual([
      expect.objectContaining({
        outcome: 'won',
        ownerId: 'owner-2',
        stageId: 'negotiate',
        supersededAt: null,
      }),
    ])
  })

  it('supersedes a loss when the opportunity is reopened, and starts a new visit', () => {
    const rows = metricRowsOf([
      created(0),
      fact(20, { type: 'lost', closedOn: '2026-09-01', lossReasonId: 'price', note: null }),
      fact(40, {
        type: 'reopened',
        previousStatus: 'lost',
        stageId: 'propose',
        probabilityBps: 5000,
      }),
      fact(50, { type: 'lost', closedOn: '2026-09-01', lossReasonId: 'timing', note: null }),
    ])
    expect(
      rows.closures.map((closure) => [
        closure.lossReasonId,
        closure.supersededAt?.getUTCMinutes() ?? null,
      ]),
    ).toEqual([
      ['price', 40],
      ['timing', null],
    ])
    expect(rows.visits.map((visit) => [visit.stageId, visit.exit])).toEqual([
      ['qualify', 'lost'],
      ['propose', 'lost'],
    ])
  })

  it('counts a conversion from a loss as the win, and a conversion after a manual win as nothing new', () => {
    const fromLoss = metricRowsOf([
      created(0),
      fact(10, { type: 'lost', closedOn: '2026-09-01', lossReasonId: 'price', note: null }),
      fact(20, {
        type: 'converted',
        quote: { quoteId: 'q2', quoteRoot: 'q1', quoteVersion: 2 },
        value: { amount: '150000', currency: 'BRL' },
        closedOn: '2026-09-01',
      }),
    ])
    expect(
      fromLoss.closures.map((closure) => [
        closure.outcome,
        closure.supersededAt?.getUTCMinutes() ?? null,
      ]),
    ).toEqual([
      ['lost', 20],
      ['won', null],
    ])
    expect(fromLoss.states.at(-1)).toMatchObject({ status: 'won', amount: '150000' })

    const afterWin = metricRowsOf([
      created(0),
      fact(10, { type: 'won', closedOn: '2026-08-31' }),
      fact(20, {
        type: 'converted',
        quote: { quoteId: 'q', quoteRoot: 'q', quoteVersion: 1 },
        value: { amount: '90000', currency: 'BRL' },
        closedOn: '2026-09-01',
      }),
    ])
    expect(afterWin.closures).toHaveLength(1)
    expect(afterWin.visits.map((visit) => visit.exit)).toEqual(['won'])
    expect(afterWin.states.at(-1)).toMatchObject({ amount: '90000', closedOn: '2026-08-31' })
  })

  it('keeps an open visit open and gives the same rows whatever order the facts come back in', () => {
    const history = [
      created(0),
      fact(5, {
        type: 'revised',
        title: 'Renovação 2027',
        contactIds: [],
        sourceId: null,
        expectedValue: { amount: '120000', currency: 'BRL' },
        expectedCloseOn: '2026-11-30',
      }),
      move(10, 'qualify', 'propose', 5000),
    ]
    const rows = metricRowsOf(history)
    expect(rows.visits.at(-1)).toMatchObject({ stageId: 'propose', leftAt: null, exit: null })
    expect(rows.closures).toEqual([])
    expect(metricRowsOf([...history].reverse())).toEqual(rows)
  })
})
