import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

const instant = (name: string) => timestamp(name, { withTimezone: true })

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  createdAt: instant('created_at').defaultNow().notNull(),
})

export const eventJournal = pgTable(
  'event_journal',
  {
    sourceModule: text('source_module').notNull(),
    eventId: uuid('event_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    eventType: text('event_type').notNull(),
    eventVersion: smallint('event_version').notNull(),
    occurredAt: instant('occurred_at').notNull(),
    traceId: text('trace_id').notNull(),
    payload: jsonb('payload').notNull(),
    arrival: text('arrival').notNull(),
    recordedAt: instant('recorded_at').defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.sourceModule, table.eventId] })],
)

export const sourceSeals = pgTable('source_seals', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  sourceModule: text('source_module').notNull(),
  through: instant('through').notNull(),
  producerCount: integer('producer_count').notNull(),
  journalCount: integer('journal_count').notNull(),
  outcome: text('outcome').notNull(),
  sealedAt: instant('sealed_at').notNull(),
  receivedAt: instant('received_at').notNull(),
})

export const sourceWatermarks = pgTable(
  'source_watermarks',
  {
    tenantId: uuid('tenant_id').notNull(),
    sourceModule: text('source_module').notNull(),
    through: instant('through').notNull(),
    sealId: uuid('seal_id').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.sourceModule] })],
)
