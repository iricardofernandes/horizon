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
