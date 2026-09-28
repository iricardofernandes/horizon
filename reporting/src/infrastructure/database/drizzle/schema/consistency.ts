import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/** One consistency run, as it was (Phase 69). */
export const consistencyRuns = pgTable('consistency_runs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  trigger: text('trigger').notNull(),
  outcome: text('outcome').notNull(),
  checks: jsonb('checks').notNull(),
  pendingPostings: integer('pending_postings'),
  startedBy: text('started_by').notNull(),
  startedAt: instant('started_at').notNull(),
  finishedAt: instant('finished_at').notNull(),
})
