import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './sales'

/** Fiscal's tax estimate of a quote or an order (Phase 87, ADR 0073); never a tax owed. */
export const taxEstimates = pgTable(
  'tax_estimates',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentKind: text('document_kind').notNull(),
    documentId: uuid('document_id').notNull(),
    estimate: jsonb('estimate').notNull(),
    inputDigest: text('input_digest').notNull(),
    rulesDigest: text('rules_digest').notNull(),
    resultDigest: text('result_digest').notNull(),
    recordedBy: text('recorded_by').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.documentKind, table.documentId] })],
)
