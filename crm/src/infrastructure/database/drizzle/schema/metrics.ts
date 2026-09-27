import {
  bigint,
  date,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenants } from './crm'

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/** What an opportunity looked like from one fact until the next (Phase 59). */
export const metricStates = pgTable(
  'metric_states',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    opportunityId: uuid('opportunity_id').notNull(),
    sequence: integer('sequence').notNull(),
    validFrom: instant('valid_from').notNull(),
    validTo: instant('valid_to'),
    pipelineId: uuid('pipeline_id').notNull(),
    stageId: uuid('stage_id').notNull(),
    probabilityBps: integer('probability_bps').notNull(),
    ownerId: uuid('owner_id').notNull(),
    sourceId: uuid('source_id'),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    expectedCloseOn: date('expected_close_on', { mode: 'string' }).notNull(),
    status: text('status').notNull(),
    closedOn: date('closed_on', { mode: 'string' }),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.opportunityId, table.sequence] })],
)

/** One stay of an opportunity in a stage (Phase 59). */
export const metricStageVisits = pgTable(
  'metric_stage_visits',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    opportunityId: uuid('opportunity_id').notNull(),
    enteredSequence: integer('entered_sequence').notNull(),
    pipelineId: uuid('pipeline_id').notNull(),
    stageId: uuid('stage_id').notNull(),
    enteredAt: instant('entered_at').notNull(),
    leftAt: instant('left_at'),
    exit: text('exit'),
    toStageId: uuid('to_stage_id'),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.opportunityId, table.enteredSequence] }),
  ],
)

/** Each win or loss, until superseded (Phase 59). */
export const metricClosures = pgTable(
  'metric_closures',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    opportunityId: uuid('opportunity_id').notNull(),
    sequence: integer('sequence').notNull(),
    outcome: text('outcome').notNull(),
    recordedAt: instant('recorded_at').notNull(),
    closedOn: date('closed_on', { mode: 'string' }).notNull(),
    pipelineId: uuid('pipeline_id').notNull(),
    stageId: uuid('stage_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    sourceId: uuid('source_id'),
    lossReasonId: uuid('loss_reason_id'),
    supersededAt: instant('superseded_at'),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.opportunityId, table.sequence] })],
)
