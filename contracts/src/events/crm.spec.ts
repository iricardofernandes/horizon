import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { crmOpportunityCreated, crmOpportunityLost, crmOpportunityReopened } from './crm'

const base = {
  opportunityId: randomUUID(),
  accountId: randomUUID(),
  pipelineId: randomUUID(),
  stageId: randomUUID(),
}

describe('opportunity events', () => {
  it('carries the stage probability and refuses a title', () => {
    const created = {
      ...base,
      probabilityBps: 2500,
      ownerId: randomUUID(),
      sourceId: null,
      expectedValue: { amount: '1500000', currency: 'BRL' },
      expectedCloseOn: '2026-12-15',
    }
    expect(crmOpportunityCreated.payload.safeParse(created).success).toBe(true)
    expect(crmOpportunityCreated.payload.safeParse({ ...created, title: 'Maria' }).success).toBe(
      false,
    )
    expect(
      crmOpportunityCreated.payload.safeParse({ ...created, probabilityBps: 10_001 }).success,
    ).toBe(false)
  })

  it('names the loss reason and the status a reopening came from', () => {
    const closure = {
      ...base,
      ownerId: randomUUID(),
      sourceId: randomUUID(),
      value: { amount: '100', currency: 'BRL' },
      closedOn: '2026-09-27',
    }
    expect(crmOpportunityLost.payload.safeParse(closure).success).toBe(false)
    expect(
      crmOpportunityLost.payload.safeParse({ ...closure, lossReasonId: randomUUID() }).success,
    ).toBe(true)
    expect(
      crmOpportunityReopened.payload.safeParse({
        ...base,
        probabilityBps: 0,
        previousStatus: 'open',
      }).success,
    ).toBe(false)
  })
})
