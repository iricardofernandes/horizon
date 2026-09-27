import {
  bigint,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { customers, tenants } from './sales'

/** Services sold and delivered stage by stage (Phase 50, ADR 0056). */
export const serviceOrders = pgTable(
  'service_orders',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    quoteId: uuid('quote_id'),
    status: text('status').notNull(),
    currency: text('currency').notNull(),
    net: bigint('net', { mode: 'bigint' }).notNull(),
    discount: bigint('discount', { mode: 'bigint' }).notNull(),
    total: bigint('total', { mode: 'bigint' }).notNull(),
    billed: bigint('billed', { mode: 'bigint' }).notNull(),
    paymentTermDays: jsonb('payment_term_days').$type<number[]>().notNull(),
    notes: text('notes'),
    scheduledFor: date('scheduled_for', { mode: 'string' }),
    openedOn: date('opened_on', { mode: 'string' }).notNull(),
    createdBy: text('created_by').notNull(),
    acceptedBy: text('accepted_by'),
    closureReason: text('closure_reason'),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('service_orders_tenant_id_key').on(table.tenantId, table.id),
    index('service_orders_status_idx').on(table.tenantId, table.status, table.createdAt),
    foreignKey({
      name: 'service_orders_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
  ],
)

export const serviceOrderLines = pgTable(
  'service_order_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceOrderId: uuid('service_order_id').notNull(),
    lineId: uuid('line_id').notNull(),
    itemId: uuid('item_id').notNull(),
    description: text('description').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    unitPrice: bigint('unit_price', { mode: 'bigint' }).notNull(),
    lineTotal: bigint('line_total', { mode: 'bigint' }).notNull(),
    delivered: bigint('delivered', { mode: 'bigint' }).notNull(),
    position: smallint('position').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.serviceOrderId, table.lineId] })],
)

export const serviceDeliveries = pgTable(
  'service_deliveries',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceOrderId: uuid('service_order_id').notNull(),
    performedOn: date('performed_on', { mode: 'string' }).notNull(),
    value: bigint('value', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    deliveredBy: text('delivered_by').notNull(),
    status: text('status').notNull(),
    cancelledBy: text('cancelled_by'),
    cancelledOn: date('cancelled_on', { mode: 'string' }),
    cancellationReason: text('cancellation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    index('service_deliveries_order_idx').on(table.tenantId, table.serviceOrderId, table.createdAt),
  ],
)

export const serviceDeliveryLines = pgTable(
  'service_delivery_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    deliveryId: uuid('delivery_id').notNull(),
    entryId: uuid('entry_id').notNull(),
    lineId: uuid('line_id').notNull(),
    itemId: uuid('item_id').notNull(),
    description: text('description').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    unitPrice: bigint('unit_price', { mode: 'bigint' }).notNull(),
    lineTotal: bigint('line_total', { mode: 'bigint' }).notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    position: smallint('position').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.entryId] })],
)

/** The receivable a delivery raised, as Financial reported it (Phase 53). */
export const serviceDeliveryEffects = pgTable(
  'service_delivery_effects',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    deliveryId: uuid('delivery_id').notNull(),
    receivableTitleId: uuid('receivable_title_id').notNull(),
    receivablePostedAt: timestamp('receivable_posted_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    receivableReversedAt: timestamp('receivable_reversed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.deliveryId] })],
)

/** The NFS-e of one delivered line, as Fiscal reported it (Phase 53). */
export const serviceDeliveryLineNfse = pgTable(
  'service_delivery_line_nfse',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    entryId: uuid('entry_id').notNull(),
    documentId: uuid('document_id').notNull(),
    status: text('status').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.entryId] })],
)
