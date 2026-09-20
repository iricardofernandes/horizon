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

export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    active: integer('active').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('warehouses_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('warehouses_tenant_name_key').on(table.tenantId, table.name),
  ],
)

export const stockBalances = pgTable(
  'stock_balances',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    itemId: uuid('item_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    onHand: bigint('on_hand', { mode: 'bigint' }).notNull().default(0n),
    reserved: bigint('reserved', { mode: 'bigint' }).notNull().default(0n),
    averageUnitCost: bigint('average_unit_cost', { mode: 'bigint' }),
    currency: text('currency'),
    version: integer('version').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('stock_balances_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('stock_balances_tenant_item_warehouse_key').on(
      table.tenantId,
      table.itemId,
      table.warehouseId,
    ),
    foreignKey({
      name: 'stock_balances_tenant_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
  ],
)

export const stockReservations = pgTable(
  'stock_reservations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    orderVersion: integer('order_version').notNull(),
    status: text('status').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('stock_reservations_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('stock_reservations_tenant_order_key').on(table.tenantId, table.orderId),
    index('stock_reservations_expiry_idx').on(table.tenantId, table.status, table.expiresAt),
  ],
)

export const stockReservationLines = pgTable(
  'stock_reservation_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    reservationId: uuid('reservation_id').notNull(),
    lineId: uuid('line_id').notNull(),
    itemId: uuid('item_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    shipped: bigint('shipped', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.reservationId, table.lineId] }),
    foreignKey({
      name: 'stock_reservation_lines_reservation_fk',
      columns: [table.tenantId, table.reservationId],
      foreignColumns: [stockReservations.tenantId, stockReservations.id],
    }),
    foreignKey({
      name: 'stock_reservation_lines_balance_fk',
      columns: [table.tenantId, table.itemId, table.warehouseId],
      foreignColumns: [stockBalances.tenantId, stockBalances.itemId, stockBalances.warehouseId],
    }),
  ],
)

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    balanceId: uuid('balance_id').notNull(),
    itemId: uuid('item_id').notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    kind: text('kind').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'bigint' }).notNull(),
    unitCost: bigint('unit_cost', { mode: 'bigint' }),
    currency: text('currency'),
    balanceVersion: integer('balance_version').notNull(),
    reason: text('reason'),
    documentType: text('document_type'),
    documentId: uuid('document_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('stock_movements_balance_version_key').on(
      table.tenantId,
      table.balanceId,
      table.balanceVersion,
    ),
    index('stock_movements_tenant_item_idx').on(table.tenantId, table.itemId, table.occurredAt),
    foreignKey({
      name: 'stock_movements_balance_fk',
      columns: [table.tenantId, table.balanceId],
      foreignColumns: [stockBalances.tenantId, stockBalances.id],
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

export const stockTransfers = pgTable(
  'stock_transfers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sourceWarehouseId: uuid('source_warehouse_id').notNull(),
    destinationWarehouseId: uuid('destination_warehouse_id').notNull(),
    note: text('note'),
    movedBy: text('moved_by').notNull(),
    movedAt: timestamp('moved_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('stock_transfers_tenant_id_key').on(table.tenantId, table.id),
    index('stock_transfers_tenant_moved_idx').on(table.tenantId, table.movedAt),
    foreignKey({
      name: 'stock_transfers_source_fk',
      columns: [table.tenantId, table.sourceWarehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    foreignKey({
      name: 'stock_transfers_destination_fk',
      columns: [table.tenantId, table.destinationWarehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
  ],
)

export const stockTransferLines = pgTable(
  'stock_transfer_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    transferId: uuid('transfer_id').notNull(),
    itemId: uuid('item_id').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.transferId, table.itemId] }),
    foreignKey({
      name: 'stock_transfer_lines_transfer_fk',
      columns: [table.tenantId, table.transferId],
      foreignColumns: [stockTransfers.tenantId, stockTransfers.id],
    }),
  ],
)

export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    warehouseId: uuid('warehouse_id').notNull(),
    itemId: uuid('item_id').notNull(),
    direction: text('direction').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    reason: text('reason').notNull(),
    note: text('note'),
    statedUnitCost: bigint('stated_unit_cost', { mode: 'bigint' }),
    statedCurrency: text('stated_currency'),
    value: bigint('value', { mode: 'bigint' }),
    valueCurrency: text('value_currency'),
    status: text('status').notNull(),
    approvalState: text('approval_state').notNull(),
    requestedBy: text('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'date' }).notNull(),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decisionReason: text('decision_reason'),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('stock_adjustments_tenant_id_key').on(table.tenantId, table.id),
    index('stock_adjustments_tenant_status_idx').on(
      table.tenantId,
      table.status,
      table.requestedAt,
    ),
    foreignKey({
      name: 'stock_adjustments_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
  ],
)

export const stockCounts = pgTable(
  'stock_counts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    warehouseId: uuid('warehouse_id').notNull(),
    note: text('note'),
    status: text('status').notNull(),
    approvalState: text('approval_state').notNull(),
    openedBy: text('opened_by').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }).notNull(),
    closedBy: text('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    closureReason: text('closure_reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('stock_counts_tenant_id_key').on(table.tenantId, table.id),
    index('stock_counts_tenant_status_idx').on(table.tenantId, table.status, table.openedAt),
    foreignKey({
      name: 'stock_counts_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
  ],
)

export const stockCountLines = pgTable(
  'stock_count_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    countId: uuid('count_id').notNull(),
    itemId: uuid('item_id').notNull(),
    expected: bigint('expected', { mode: 'bigint' }).notNull(),
    counted: bigint('counted', { mode: 'bigint' }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.countId, table.itemId] }),
    foreignKey({
      name: 'stock_count_lines_count_fk',
      columns: [table.tenantId, table.countId],
      foreignColumns: [stockCounts.tenantId, stockCounts.id],
    }),
  ],
)

export const adjustmentPolicies = pgTable(
  'adjustment_policies',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    currency: text('currency').notNull(),
    threshold: bigint('threshold', { mode: 'bigint' }).notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.currency] })],
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
    response: jsonb('response').$type<unknown>().notNull(),
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
