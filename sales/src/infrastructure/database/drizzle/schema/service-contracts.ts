import {
  bigint,
  boolean,
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

/** Services sold for a recurring fee (Phase 51, ADR 0056). */
export const serviceContracts = pgTable('service_contracts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  customerId: uuid('customer_id').notNull(),
  currency: text('currency').notNull(),
  startsOn: date('starts_on', { mode: 'string' }).notNull(),
  endsOn: date('ends_on', { mode: 'string' }),
  billingDay: smallint('billing_day').notNull(),
  autoRenew: boolean('auto_renew').notNull(),
  termMonths: integer('term_months'),
  paymentTermDays: jsonb('payment_term_days').$type<number[]>().notNull(),
  sellerId: uuid('seller_id'),
  notes: text('notes'),
  stage: text('stage').notNull(),
  cancelledFrom: date('cancelled_from', { mode: 'string' }),
  cancellationReason: text('cancellation_reason'),
  cancelledBy: text('cancelled_by'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
  createdBy: text('created_by').notNull(),
  activatedAt: timestamp('activated_at', { withTimezone: true, mode: 'date' }),
  version: integer('version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
})

export const serviceContractRevisions = pgTable(
  'service_contract_revisions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    contractId: uuid('contract_id').notNull(),
    revision: integer('revision').notNull(),
    kind: text('kind').notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    recurrence: text('recurrence').notNull(),
    readjustmentBasisPoints: integer('readjustment_basis_points'),
    reason: text('reason'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.contractId, table.revision] })],
)

export const serviceContractRevisionLines = pgTable(
  'service_contract_revision_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    contractId: uuid('contract_id').notNull(),
    revision: integer('revision').notNull(),
    lineId: uuid('line_id').notNull(),
    itemId: uuid('item_id').notNull(),
    description: text('description').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    unitPrice: bigint('unit_price', { mode: 'bigint' }).notNull(),
    position: smallint('position').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.contractId, table.revision, table.lineId] }),
  ],
)

export const serviceContractSuspensions = pgTable('service_contract_suspensions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  contractId: uuid('contract_id').notNull(),
  fromDate: date('from_date', { mode: 'string' }).notNull(),
  untilDate: date('until_date', { mode: 'string' }),
  reason: text('reason').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
})
