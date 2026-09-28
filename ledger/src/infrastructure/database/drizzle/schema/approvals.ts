import {
  bigint,
  date,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import type { ManualEntryLine } from '@/domain/entities/manual-entry'
import { tenants } from './ledger'

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/** At or above the threshold, a manual entry waits for a second person (Phase 68). */
export const entryApprovalPolicies = pgTable(
  'entry_approval_policies',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    currency: text('currency').notNull(),
    threshold: bigint('threshold', { mode: 'bigint' }).notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.currency] })],
)

export const manualEntries = pgTable('manual_entries', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  reference: text('reference').notNull(),
  postedOn: date('posted_on', { mode: 'string' }).notNull(),
  currency: text('currency').notNull(),
  memo: text('memo'),
  lines: jsonb('lines').$type<ManualEntryLine[]>().notNull(),
  total: bigint('total', { mode: 'bigint' }).notNull(),
  status: text('status').notNull(),
  requestedBy: text('requested_by').notNull(),
  requestedAt: instant('requested_at').notNull(),
  decidedBy: text('decided_by'),
  decidedFor: text('decided_for'),
  decidedAt: instant('decided_at'),
  decisionReason: text('decision_reason'),
  transactionId: uuid('transaction_id'),
  updatedAt: instant('updated_at').notNull(),
})
