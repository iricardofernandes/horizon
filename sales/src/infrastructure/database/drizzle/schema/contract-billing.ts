import {
  bigint,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenants } from './sales'

/** A contract period as it was billed (Phase 52): its facts never change. */
export const contractBilledPeriods = pgTable('contract_billed_periods', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  contractId: uuid('contract_id').notNull(),
  competence: text('competence').notNull(),
  revision: integer('revision').notNull(),
  startsOn: date('starts_on', { mode: 'string' }).notNull(),
  endsOn: date('ends_on', { mode: 'string' }).notNull(),
  issuedOn: date('issued_on', { mode: 'string' }).notNull(),
  currency: text('currency').notNull(),
  value: bigint('value', { mode: 'bigint' }).notNull(),
  installments: jsonb('installments')
    .$type<{ number: number; dueOn: string; amount: string }[]>()
    .notNull(),
  runId: uuid('run_id'),
  billedBy: text('billed_by').notNull(),
  billedAt: timestamp('billed_at', { withTimezone: true, mode: 'date' }).notNull(),
  creditReasonCode: text('credit_reason_code'),
  creditReason: text('credit_reason'),
  creditedOn: date('credited_on', { mode: 'string' }),
  creditedBy: text('credited_by'),
  creditedAt: timestamp('credited_at', { withTimezone: true, mode: 'date' }),
  receivableTitleId: uuid('receivable_title_id'),
  receivablePostedAt: timestamp('receivable_posted_at', { withTimezone: true, mode: 'date' }),
  receivableReversedAt: timestamp('receivable_reversed_at', { withTimezone: true, mode: 'date' }),
})

export const contractBilledPeriodLines = pgTable(
  'contract_billed_period_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    entryId: uuid('entry_id').notNull(),
    billedPeriodId: uuid('billed_period_id').notNull(),
    lineId: uuid('line_id').notNull(),
    itemId: uuid('item_id').notNull(),
    description: text('description').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    unitPrice: bigint('unit_price', { mode: 'bigint' }).notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    position: smallint('position').notNull(),
    nfseDocumentId: uuid('nfse_document_id'),
    nfseStatus: text('nfse_status'),
    nfseObservedAt: timestamp('nfse_observed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.entryId] })],
)

export const contractBillingRuns = pgTable('contract_billing_runs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  competence: text('competence').notNull(),
  status: text('status').notNull(),
  requestedBy: text('requested_by').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
})

export const contractBillingRunItems = pgTable(
  'contract_billing_run_items',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    runId: uuid('run_id').notNull(),
    contractId: uuid('contract_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason'),
    billedPeriodId: uuid('billed_period_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.runId, table.contractId] })],
)
