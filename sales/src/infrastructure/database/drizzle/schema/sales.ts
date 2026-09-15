import { sql } from 'drizzle-orm'
import {
  bigint,
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

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
})

export const catalogItems = pgTable(
  'catalog_items',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    itemId: uuid('item_id').notNull(),
    description: text('description').notNull(),
    unitPrice: bigint('unit_price', { mode: 'bigint' }),
    currency: text('currency'),
    active: integer('active').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.itemId] })],
)

export const customerDataKeys = pgTable(
  'customer_data_keys',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    material: text('material'),
    erasedAt: timestamp('erased_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [uniqueIndex('customer_data_keys_tenant_id_key').on(table.tenantId, table.id)],
)

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    nameCiphertext: text('name_ciphertext').notNull(),
    taxIdCiphertext: text('tax_id_ciphertext').notNull(),
    taxIdIndex: text('tax_id_index').notNull(),
    emailCiphertext: text('email_ciphertext').notNull(),
    phoneCiphertext: text('phone_ciphertext').notNull(),
    addressCiphertext: text('address_ciphertext').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('customers_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('customers_tenant_tax_id_index_key').on(table.tenantId, table.taxIdIndex),
    foreignKey({
      name: 'customers_tenant_data_key_fk',
      columns: [table.tenantId, table.id],
      foreignColumns: [customerDataKeys.tenantId, customerDataKeys.id],
    }),
  ],
)

export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    status: text('status').notNull(),
    total: bigint('total', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('quotes_tenant_id_key').on(table.tenantId, table.id),
    index('quotes_tenant_customer_idx').on(table.tenantId, table.customerId, table.createdAt),
    foreignKey({
      name: 'quotes_tenant_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
  ],
)

export const quoteLines = pgTable(
  'quote_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    quoteId: uuid('quote_id').notNull(),
    lineId: uuid('line_id').notNull(),
    itemId: uuid('item_id').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    description: text('description').notNull(),
    unitPrice: bigint('unit_price', { mode: 'bigint' }).notNull(),
    lineTotal: bigint('line_total', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.quoteId, table.lineId] }),
    uniqueIndex('quote_lines_tenant_quote_item_key').on(
      table.tenantId,
      table.quoteId,
      table.itemId,
    ),
    foreignKey({
      name: 'quote_lines_quote_fk',
      columns: [table.tenantId, table.quoteId],
      foreignColumns: [quotes.tenantId, quotes.id],
    }),
  ],
)

export const salesOrders = pgTable(
  'sales_orders',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    fulfillmentWarehouseId: uuid('fulfillment_warehouse_id').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    reservationId: uuid('reservation_id'),
    total: bigint('total', { mode: 'bigint' }),
    currency: text('currency'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('sales_orders_tenant_id_key').on(table.tenantId, table.id),
    index('sales_orders_tenant_customer_idx').on(table.tenantId, table.customerId, table.createdAt),
  ],
)

export const salesOrderLines = pgTable(
  'sales_order_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    lineId: uuid('line_id').notNull(),
    itemId: uuid('item_id').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    description: text('description'),
    unitPrice: bigint('unit_price', { mode: 'bigint' }),
    lineTotal: bigint('line_total', { mode: 'bigint' }),
    currency: text('currency'),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.orderId, table.lineId] }),
    uniqueIndex('sales_order_lines_tenant_order_item_key').on(
      table.tenantId,
      table.orderId,
      table.itemId,
    ),
    foreignKey({
      name: 'sales_order_lines_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [salesOrders.tenantId, salesOrders.id],
    }),
  ],
)

export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    eventVersion: smallint('event_version').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    traceId: text('trace_id').notNull(),
    traceParent: text('trace_parent'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true, mode: 'date' }),
    attempts: smallint('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (table) => [
    uniqueIndex('outbox_event_id_key').on(table.eventId),
    index('outbox_undispatched_idx').on(table.createdAt).where(sql`dispatched_at IS NULL`),
  ],
)

export const inbox = pgTable(
  'inbox',
  {
    sourceModule: text('source_module').notNull(),
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('inbox_source_event_key').on(table.sourceModule, table.eventId)],
)
