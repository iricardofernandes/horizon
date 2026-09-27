import { z } from 'zod'

import { dateSchema, instantSchema, moneySchema, uuidSchema } from '../common'
import { defineEvent } from './define'

/**
 * Opportunity facts (ADR 0057). Each carries what a forecast or a conversion metric needs
 * at the moment it happened — pipeline, stage and its probability, owner, source, value —
 * so reporting can rebuild the funnel from the history alone. The title and the contacts
 * are deliberately absent: a title may name a person, and contacts are personal data.
 */
const opportunityId = uuidSchema.describe('The opportunity, stable across every event')
const accountId = uuidSchema.describe('The account, which is the party id')
const probabilityBps = z
  .number()
  .int()
  .min(0)
  .max(10_000)
  .describe('Win probability of the stage at that moment, in basis points')

const position = {
  pipelineId: uuidSchema,
  stageId: uuidSchema,
  probabilityBps,
}

export const crmOpportunityCreated = defineEvent({
  type: 'crm.opportunity.created',
  version: 1,
  description:
    'An opportunity was opened on an account, in a pipeline stage, owned by a user, with an expected value and close date.',
  payload: z.strictObject({
    opportunityId,
    accountId,
    ...position,
    ownerId: uuidSchema,
    sourceId: uuidSchema.nullable(),
    expectedValue: moneySchema,
    expectedCloseOn: dateSchema,
  }),
})

export const crmOpportunityRevised = defineEvent({
  type: 'crm.opportunity.revised',
  version: 1,
  description:
    'The expected value, expected close date or source of an open opportunity changed. Carries the values after the change.',
  payload: z.strictObject({
    opportunityId,
    accountId,
    sourceId: uuidSchema.nullable(),
    expectedValue: moneySchema,
    expectedCloseOn: dateSchema,
  }),
})

export const crmOpportunityStageChanged = defineEvent({
  type: 'crm.opportunity.stage-changed',
  version: 1,
  description: 'An open opportunity moved from one stage of its pipeline to another.',
  payload: z.strictObject({
    opportunityId,
    accountId,
    pipelineId: uuidSchema,
    fromStageId: uuidSchema,
    toStageId: uuidSchema,
    probabilityBps,
  }),
})

export const crmOpportunityOwnerChanged = defineEvent({
  type: 'crm.opportunity.owner-changed',
  version: 1,
  description: 'Another user now looks after the opportunity.',
  payload: z.strictObject({
    opportunityId,
    accountId,
    fromOwnerId: uuidSchema,
    toOwnerId: uuidSchema,
  }),
})

const closure = {
  opportunityId,
  accountId,
  pipelineId: uuidSchema,
  stageId: uuidSchema.describe('The stage it was in when it closed'),
  ownerId: uuidSchema,
  sourceId: uuidSchema.nullable(),
  value: moneySchema,
  closedOn: dateSchema,
}

export const crmOpportunityWon = defineEvent({
  type: 'crm.opportunity.won',
  version: 1,
  description: 'The opportunity was won, at the value it carried when it closed.',
  payload: z.strictObject(closure),
})

export const crmOpportunityLost = defineEvent({
  type: 'crm.opportunity.lost',
  version: 1,
  description:
    'The opportunity was lost, with the reason from the workspace list. Reopening it later keeps this closure in the history.',
  payload: z.strictObject({ ...closure, lossReasonId: uuidSchema }),
})

export const crmOpportunityReopened = defineEvent({
  type: 'crm.opportunity.reopened',
  version: 1,
  description: 'A won or lost opportunity was opened again, in an active stage of its pipeline.',
  payload: z.strictObject({
    opportunityId,
    accountId,
    ...position,
    previousStatus: z.enum(['won', 'lost']),
  }),
})

export const crmOpportunityConverted = defineEvent({
  type: 'crm.opportunity.converted',
  version: 1,
  description:
    'A Sales quote for the opportunity was accepted: the opportunity is won at the quote total, with the owner and source it had. Sent once per opportunity; crm.opportunity.won is also sent when it was not won already.',
  payload: z.strictObject({
    opportunityId,
    accountId,
    quoteId: uuidSchema.describe('The accepted version'),
    quoteRoot: uuidSchema.describe('The offer every version of the quote shares'),
    quoteVersion: z.number().int().positive(),
    value: moneySchema.describe('The accepted quote total'),
    ownerId: uuidSchema,
    sourceId: uuidSchema.nullable(),
    closedOn: dateSchema,
  }),
})

/**
 * A task's reminder came due (Phase 57). Published once per armed reminder, even across
 * scheduler restarts, so a webhook can alert the assignee. The title is never published:
 * it is free text that may name a person.
 */
export const crmTaskDue = defineEvent({
  type: 'crm.task.due',
  version: 1,
  description:
    'The reminder of an open task came due. Sent once per reminder; rescheduling the task arms a new one.',
  payload: z.strictObject({
    taskId: uuidSchema,
    accountId,
    subject: z.strictObject({
      type: z.enum(['account', 'contact', 'opportunity']),
      id: uuidSchema,
    }),
    assigneeId: uuidSchema.describe('The user the task is assigned to'),
    dueAt: instantSchema,
    remindAt: instantSchema,
  }),
})
