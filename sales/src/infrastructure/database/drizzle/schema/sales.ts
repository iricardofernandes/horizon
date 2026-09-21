import { sql } from 'drizzle-orm'
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

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
})

/** One outbox announcement for each billable operational origin and purpose. */
export const fiscalOrigins = pgTable(
  'fiscal_origins',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    originModule: text('origin_module').notNull(),
    documentType: text('document_type').notNull(),
    documentId: uuid('document_id').notNull(),
    purpose: text('purpose').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('fiscal_origins_one_request_key').on(
      table.tenantId,
      table.originModule,
      table.documentType,
      table.documentId,
      table.purpose,
    ),
  ],
)

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
    taxIdCiphertext: text('tax_id_ciphertext'),
    taxIdIndex: text('tax_id_index'),
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
    /** Every version of one offer shares the first version's identifier. */
    rootId: uuid('root_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull(),
    net: bigint('net', { mode: 'bigint' }).notNull(),
    total: bigint('total', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    sellerId: uuid('seller_id'),
    discount: bigint('discount', { mode: 'bigint' }).notNull(),
    freight: bigint('freight', { mode: 'bigint' }).notNull(),
    carrier: text('carrier'),
    paymentTermDays: jsonb('payment_term_days').$type<number[]>().notNull(),
    notes: text('notes'),
    approvalState: text('approval_state').notNull(),
    approvalRequestedBy: text('approval_requested_by'),
    approvalRequestedAt: timestamp('approval_requested_at', { withTimezone: true, mode: 'date' }),
    approvalDecidedBy: text('approval_decided_by'),
    approvalDecidedAt: timestamp('approval_decided_at', { withTimezone: true, mode: 'date' }),
    approvalReason: text('approval_reason'),
    supersedes: uuid('supersedes'),
    supersededBy: uuid('superseded_by'),
    closureReason: text('closure_reason'),
    orderId: uuid('order_id'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
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
    fulfillment: text('fulfillment').notNull(),
    shipments: integer('shipments').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    version: integer('version').notNull(),
    reservationId: uuid('reservation_id'),
    total: bigint('total', { mode: 'bigint' }),
    currency: text('currency'),
    quoteId: uuid('quote_id'),
    sellerId: uuid('seller_id'),
    discount: bigint('discount', { mode: 'bigint' }).notNull(),
    freight: bigint('freight', { mode: 'bigint' }).notNull(),
    carrier: text('carrier'),
    paymentTermDays: jsonb('payment_term_days').$type<number[]>().notNull(),
    issuedOn: date('issued_on', { mode: 'string' }).notNull(),
    notes: text('notes'),
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
    shipped: bigint('shipped', { mode: 'bigint' }).notNull(),
    allocated: bigint('allocated', { mode: 'bigint' }).notNull(),
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

export const commandReceipts = pgTable(
  'command_receipts',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    idempotencyKey: text('idempotency_key').notNull(),
    command: text('command').notNull(),
    fingerprint: text('fingerprint').notNull(),
    response: jsonb('response').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.idempotencyKey] })],
)

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  sequence: bigint('sequence', { mode: 'number' }).notNull(),
  actor: text('actor').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  action: text('action').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  requestId: text('request_id'),
  traceId: text('trace_id'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull(),
  previousHash: text('previous_hash').notNull(),
  hash: text('hash').notNull(),
})

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    status: text('status').notNull(),
    value: bigint('value', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    carrier: text('carrier'),
    trackingCode: text('tracking_code'),
    pickedBy: text('picked_by').notNull(),
    packedBy: text('packed_by'),
    dispatchedBy: text('dispatched_by'),
    dispatchedOn: date('dispatched_on', { mode: 'string' }),
    returnedBy: text('returned_by'),
    returnedOn: date('returned_on', { mode: 'string' }),
    closureReason: text('closure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('shipments_tenant_id_key').on(table.tenantId, table.id),
    index('shipments_order_idx').on(table.tenantId, table.orderId, table.createdAt),
    index('shipments_status_idx').on(table.tenantId, table.status, table.createdAt),
    foreignKey({
      name: 'shipments_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [salesOrders.tenantId, salesOrders.id],
    }),
  ],
)

export const shipmentLines = pgTable(
  'shipment_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    shipmentId: uuid('shipment_id').notNull(),
    lineId: uuid('line_id').notNull(),
    itemId: uuid('item_id').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    description: text('description').notNull(),
    unitPrice: bigint('unit_price', { mode: 'bigint' }).notNull(),
    lineTotal: bigint('line_total', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.shipmentId, table.lineId] }),
    foreignKey({
      name: 'shipment_lines_shipment_fk',
      columns: [table.tenantId, table.shipmentId],
      foreignColumns: [shipments.tenantId, shipments.id],
    }),
  ],
)
