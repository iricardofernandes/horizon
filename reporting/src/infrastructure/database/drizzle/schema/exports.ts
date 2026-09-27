import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const instant = (name: string) => timestamp(name, { withTimezone: true })

export const exportJobs = pgTable('export_jobs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  requestedBy: text('requested_by').notNull(),
  report: text('report').notNull(),
  filter: jsonb('filter').notNull(),
  cutoff: instant('cutoff').notNull(),
  format: text('format').notNull(),
  locale: text('locale').notNull(),
  scheduleId: uuid('schedule_id'),
  status: text('status').notNull(),
  settled: boolean('settled'),
  rows: integer('rows'),
  bytes: integer('bytes'),
  sha256: text('sha256'),
  objectKey: text('object_key'),
  failure: text('failure'),
  requestedAt: instant('requested_at').notNull(),
  startedAt: instant('started_at'),
  finishedAt: instant('finished_at'),
  expiresAt: instant('expires_at'),
})

export const exportSchedules = pgTable('export_schedules', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  ownerId: text('owner_id').notNull(),
  report: text('report').notNull(),
  filter: jsonb('filter').notNull(),
  format: text('format').notNull(),
  locale: text('locale').notNull(),
  cadence: text('cadence').notNull(),
  timeZone: text('time_zone').notNull(),
  nextDueAt: instant('next_due_at').notNull(),
  active: boolean('active').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})
