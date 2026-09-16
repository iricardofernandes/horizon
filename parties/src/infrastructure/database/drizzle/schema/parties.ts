import { sql } from 'drizzle-orm'
import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Tenant rows are created lazily, inside the tenant's own transaction, the first time a
 * party is written. RLS, grants and triggers live in the migration, not here.
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
})

/** One key per party. Destroying `material` is the erasure (ADR 0026). */
export const partyDataKeys = pgTable(
  'party_data_keys',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    material: text('material'),
    erasedAt: timestamp('erased_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [uniqueIndex('party_data_keys_tenant_id_key').on(table.tenantId, table.id)],
)

export const parties = pgTable(
  'parties',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    legalNameCiphertext: text('legal_name_ciphertext').notNull(),
    tradeNameCiphertext: text('trade_name_ciphertext'),
    taxIdCiphertext: text('tax_id_ciphertext').notNull(),
    taxIdIndex: text('tax_id_index').notNull(),
    emailCiphertext: text('email_ciphertext').notNull(),
    phoneCiphertext: text('phone_ciphertext').notNull(),
    addressCiphertext: text('address_ciphertext').notNull(),
    roles: text('roles').array().notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('parties_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('parties_tenant_tax_id_index_key').on(table.tenantId, table.taxIdIndex),
    index('parties_tenant_created_idx').on(table.tenantId, table.createdAt),
    foreignKey({
      name: 'parties_tenant_data_key_fk',
      columns: [table.tenantId, table.id],
      foreignColumns: [partyDataKeys.tenantId, partyDataKeys.id],
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
