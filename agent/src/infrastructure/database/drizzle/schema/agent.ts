import { bigint, boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const instant = (name: string) => timestamp(name, { withTimezone: true })

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  createdAt: instant('created_at').defaultNow().notNull(),
})

export const agentSettings = pgTable('agent_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  enabled: boolean('enabled').notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  sequence: bigint('sequence', { mode: 'number' }).notNull(),
  actor: text('actor').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  action: text('action').notNull(),
  occurredAt: instant('occurred_at').notNull(),
  requestId: text('request_id'),
  traceId: text('trace_id'),
  details: jsonb('details').notNull(),
  previousHash: text('previous_hash').notNull(),
  hash: text('hash').notNull(),
})
