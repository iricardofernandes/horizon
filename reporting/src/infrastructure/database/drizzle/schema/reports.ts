import {
  bigint,
  boolean,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

const instant = (name: string) => timestamp(name, { withTimezone: true })

export const savedFilters = pgTable('saved_filters', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  report: text('report').notNull(),
  name: text('name').notNull(),
  filter: jsonb('filter').notNull(),
  ownerId: text('owner_id').notNull(),
  shared: boolean('shared').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const reconciliationRuns = pgTable('reconciliation_runs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  report: text('report').notNull(),
  cutoff: instant('cutoff').notNull(),
  outcome: text('outcome').notNull(),
  checks: jsonb('checks').notNull(),
  startedBy: text('started_by').notNull(),
  startedAt: instant('started_at').notNull(),
})

export const commandReceipts = pgTable(
  'command_receipts',
  {
    tenantId: uuid('tenant_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    command: text('command').notNull(),
    fingerprint: text('fingerprint').notNull(),
    response: jsonb('response').notNull(),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.idempotencyKey] })],
)

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
