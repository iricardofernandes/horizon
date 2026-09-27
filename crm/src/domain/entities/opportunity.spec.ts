import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import {
  BusinessDate,
  LabelName,
  Money,
  OpportunityTitle,
  Probability,
} from '../value-objects/crm-values'
import { foldHistory, Opportunity } from './opportunity'
import type { Stage } from './pipeline'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-27T12:00:00Z')
const later = new Date('2026-10-01T12:00:00Z')
const stage = (bps: number): Stage => ({
  id: new UniqueEntityID().toString(),
  name: valid(LabelName.create(`Etapa ${bps}`)),
  probability: valid(Probability.create(bps)),
  archived: false,
})
const qualification = stage(1000)
const proposal = stage(5000)

function opened() {
  const opportunity = Opportunity.open(
    {
      tenantId: 'tenant-a',
      accountId: 'account-1',
      title: valid(OpportunityTitle.create('Renovação 2027')),
      contactIds: ['c1', 'c1'],
      ownerId: 'u1',
      sourceId: null,
      expectedValue: valid(Money.create('1500000', 'BRL')),
      expectedCloseOn: valid(BusinessDate.create('2026-12-15')),
      pipelineId: 'p1',
      stage: qualification,
      actor: 'ana',
      now,
    },
    new UniqueEntityID(),
  )
  return opportunity
}

const terms = {
  title: valid(OpportunityTitle.create('Renovação 2027')),
  contactIds: ['c1'],
  sourceId: null,
  expectedValue: valid(Money.create('1500000', 'BRL')),
  expectedCloseOn: valid(BusinessDate.create('2026-12-15')),
}

describe('opportunities', () => {
  it('opens in a stage at its probability and publishes the creation without the title', () => {
    const deal = opened()
    expect(deal.state).toMatchObject({
      status: 'open',
      probabilityBps: 1000,
      contactIds: ['c1'],
      version: 1,
    })
    const [event] = deal.pullDomainEvents()
    expect(event?.eventType).toBe('crm.opportunity.created')
    expect(event?.payloadOf()).toMatchObject({
      probabilityBps: 1000,
      expectedValue: { amount: '1500000', currency: 'BRL' },
    })
    expect(JSON.stringify(event?.payloadOf())).not.toContain('Renovação')
  })

  it('moves, refuses the stage it is in, and records the new probability', () => {
    const deal = opened()
    expect(deal.move(qualification, 'ana', now).isLeft()).toBe(true)
    expect(deal.move(proposal, 'ana', later).isRight()).toBe(true)
    expect(deal.state).toMatchObject({
      stageId: proposal.id,
      probabilityBps: 5000,
      version: 2,
      updatedAt: later,
    })
  })

  it('publishes a revision only when the forecast changes', () => {
    const deal = opened()
    deal.pullDomainEvents()
    expect(valid(deal.revise(terms, 'ana', now))).toBe(false)
    expect(
      valid(
        deal.revise({ ...terms, title: valid(OpportunityTitle.create('Renovação')) }, 'ana', now),
      ),
    ).toBe(true)
    expect(deal.pullDomainEvents()).toHaveLength(0)
    expect(
      valid(
        deal.revise({ ...terms, expectedValue: valid(Money.create('2000000', 'BRL')) }, 'ana', now),
      ),
    ).toBe(true)
    expect(deal.pullDomainEvents().map((event) => event.eventType)).toEqual([
      'crm.opportunity.revised',
    ])
    expect(deal.pullRecordedFacts().map((recorded) => recorded.fact.type)).toEqual([
      'created',
      'revised',
      'revised',
    ])
  })

  it('keeps both closures when lost, reopened and lost again, and rebuilds from its history', () => {
    const deal = opened()
    deal.lose('reason-price', 'Caro demais', valid(BusinessDate.create('2026-09-27')), 'ana', now)
    expect(deal.state).toMatchObject({
      status: 'lost',
      lossReasonId: 'reason-price',
      closedOn: '2026-09-27',
    })
    expect(deal.move(proposal, 'ana', now).isLeft()).toBe(true)
    expect(deal.reassign('u2', 'ana', now).isLeft()).toBe(true)
    expect(deal.reopen(proposal, 'ana', later).isRight()).toBe(true)
    expect(deal.reopen(proposal, 'ana', later).isLeft()).toBe(true)
    expect(deal.state).toMatchObject({
      status: 'open',
      lossReasonId: null,
      closedOn: null,
      stageId: proposal.id,
    })
    expect(deal.reassign('u1', 'ana', later).isLeft()).toBe(true)
    deal.reassign('u2', 'bia', later)
    deal.lose('reason-timing', null, BusinessDate.of(later), 'bia', later)
    const history = deal.pullRecordedFacts()
    expect(history.map((recorded) => recorded.fact.type)).toEqual([
      'created',
      'lost',
      'reopened',
      'owner-changed',
      'lost',
    ])
    expect(history.filter((recorded) => recorded.fact.type === 'lost')).toHaveLength(2)
    expect(foldHistory(history)).toEqual(deal.state)
    expect(foldHistory([...history].reverse())).toEqual(deal.state)
    expect(deal.pullDomainEvents().map((event) => event.eventType)).toEqual([
      'crm.opportunity.created',
      'crm.opportunity.lost',
      'crm.opportunity.reopened',
      'crm.opportunity.owner-changed',
      'crm.opportunity.lost',
    ])
  })

  it('wins once, at its value, and reopens from won', () => {
    const deal = opened()
    deal.pullDomainEvents()
    deal.win(BusinessDate.of(later), 'ana', later)
    expect(deal.win(BusinessDate.of(later), 'ana', later).isLeft()).toBe(true)
    expect(deal.revise(terms, 'ana', later).isLeft()).toBe(true)
    const [won] = deal.pullDomainEvents()
    expect(won?.payloadOf()).toMatchObject({
      value: { amount: '1500000', currency: 'BRL' },
      closedOn: '2026-10-01',
    })
    deal.reopen(qualification, 'ana', later)
    const [reopened] = deal.pullDomainEvents()
    expect(reopened?.payloadOf()).toMatchObject({ previousStatus: 'won', probabilityBps: 1000 })
    expect(snapshotOf(deal).status).toBe('open')
  })

  it('refuses a history with a gap or without its creation', () => {
    const deal = opened()
    deal.move(proposal, 'ana', now)
    const history = deal.pullRecordedFacts()
    expect(() => foldHistory([history[1] as never])).toThrow()
    expect(() => foldHistory([])).toThrow()
    expect(() => foldHistory([history[0] as never, history[0] as never])).toThrow()
  })

  it('validates money and business dates', () => {
    expect(Money.create('-1', 'BRL').isLeft()).toBe(true)
    expect(Money.create('10', 'real').isLeft()).toBe(true)
    expect(BusinessDate.create('2026-02-30').isLeft()).toBe(true)
    expect(BusinessDate.create('27/09/2026').isLeft()).toBe(true)
    expect(OpportunityTitle.create('x').isLeft()).toBe(true)
  })
})
