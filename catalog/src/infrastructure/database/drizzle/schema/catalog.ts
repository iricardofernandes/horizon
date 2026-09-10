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

export const units = pgTable(
  'units_of_measure',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    decimalPlaces: integer('decimal_places').notNull(),
    active: integer('active').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('units_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('units_tenant_code_key').on(table.tenantId, table.code),
    index('units_tenant_keyset_idx').on(table.tenantId, table.createdAt, table.id),
  ],
)

export const catalogItems = pgTable(
  'catalog_items',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    unitId: uuid('unit_id').notNull(),
    ncm: text('ncm'),
    active: integer('active').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('catalog_items_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('catalog_items_tenant_sku_key').on(table.tenantId, table.sku),
    index('catalog_items_tenant_keyset_idx').on(table.tenantId, table.createdAt, table.id),
    foreignKey({
      name: 'catalog_items_tenant_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
  ],
)

export const priceLists = pgTable(
  'price_lists',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    active: integer('active').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('price_lists_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('price_lists_tenant_name_key').on(table.tenantId, table.name),
    index('price_lists_tenant_keyset_idx').on(table.tenantId, table.createdAt, table.id),
  ],
)

export const prices = pgTable(
  'prices',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    priceListId: uuid('price_list_id').notNull(),
    itemId: uuid('item_id').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.priceListId, table.itemId] }),
    foreignKey({
      name: 'prices_tenant_list_fk',
      columns: [table.tenantId, table.priceListId],
      foreignColumns: [priceLists.tenantId, priceLists.id],
    }),
    foreignKey({
      name: 'prices_tenant_item_fk',
      columns: [table.tenantId, table.itemId],
      foreignColumns: [catalogItems.tenantId, catalogItems.id],
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

export const auditLog = pgTable(
  'audit_log',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    requestId: text('request_id'),
    traceId: text('trace_id'),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    previousHash: text('previous_hash').notNull(),
    hash: text('hash').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.sequence] })],
)
