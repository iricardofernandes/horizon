import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  crmOpportunityConverted,
  crmOpportunityCreated,
  crmOpportunityLost,
  crmOpportunityReopened,
  crmTaskDue,
} from './crm'

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

describe('task events', () => {
  it('names the task, its subject and its assignee, never its title', () => {
    const due = {
      taskId: randomUUID(),
      accountId: randomUUID(),
      subject: { type: 'opportunity', id: randomUUID() },
      assigneeId: randomUUID(),
      dueAt: '2026-09-28T13:00:00.000Z',
      remindAt: '2026-09-28T12:30:00.000Z',
    }
    expect(crmTaskDue.payload.safeParse(due).success).toBe(true)
    expect(crmTaskDue.payload.safeParse({ ...due, title: 'Ligar para Maria' }).success).toBe(false)
    expect(
      crmTaskDue.payload.safeParse({ ...due, subject: { type: 'quote', id: randomUUID() } })
        .success,
    ).toBe(false)
  })
})

describe('conversion', () => {
  it('carries the accepted quote, its value and the attribution', () => {
    const converted = {
      opportunityId: randomUUID(),
      accountId: randomUUID(),
      quoteId: randomUUID(),
      quoteRoot: randomUUID(),
      quoteVersion: 2,
      value: { amount: '2800000', currency: 'BRL' },
      ownerId: randomUUID(),
      sourceId: randomUUID(),
      closedOn: '2026-09-27',
    }
    expect(crmOpportunityConverted.payload.safeParse(converted).success).toBe(true)
    expect(
      crmOpportunityConverted.payload.safeParse({ ...converted, quoteVersion: 0 }).success,
    ).toBe(false)
  })
})
