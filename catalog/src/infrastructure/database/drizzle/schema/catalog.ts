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
    classificationRevision: integer('classification_revision').notNull().default(0),
    classificationEffectiveFrom: date('classification_effective_from'),
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

export const itemClassifications = pgTable(
  'item_classifications',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    itemId: uuid('item_id').notNull(),
    revision: integer('revision').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    ncm: text('ncm'),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('item_classifications_revision_key').on(
      table.tenantId,
      table.itemId,
      table.revision,
    ),
    foreignKey({
      name: 'item_classifications_item_fk',
      columns: [table.tenantId, table.itemId],
      foreignColumns: [catalogItems.tenantId, catalogItems.id],
    }),
  ],
)

/**
 * A group of items that differ only along named axes.
 *
 * Not a thing anybody stocks or sells: it is how the catalogue says that these forty
 * shirts are one shirt in forty combinations.
 */
export const productFamilies = pgTable(
  'product_families',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    /** Ordered, and fixed once anything is in the family. */
    attributes: text('attributes').array().notNull(),
    active: integer('active').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('product_families_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('product_families_tenant_name_key').on(table.tenantId, table.name),
    index('product_families_tenant_keyset_idx').on(table.tenantId, table.createdAt, table.id),
  ],
)

/**
 * One item's place in a family, and the answers that put it there.
 *
 * `combination` is what makes two variants the same variant — the answers in the family's
 * own order, case-folded — and it is unique per family, which is the whole point of
 * varying along axes rather than just naming things differently.
 */
export const itemVariants = pgTable(
  'item_variants',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    itemId: uuid('item_id').notNull(),
    familyId: uuid('family_id').notNull(),
    combination: text('combination').notNull(),
    values: jsonb('values').$type<{ attribute: string; value: string }[]>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.itemId] }),
    uniqueIndex('item_variants_family_combination_key').on(
      table.tenantId,
      table.familyId,
      table.combination,
    ),
    foreignKey({
      name: 'item_variants_tenant_item_fk',
      columns: [table.tenantId, table.itemId],
      foreignColumns: [catalogItems.tenantId, catalogItems.id],
    }),
    foreignKey({
      name: 'item_variants_tenant_family_fk',
      columns: [table.tenantId, table.familyId],
      foreignColumns: [productFamilies.tenantId, productFamilies.id],
    }),
  ],
)

/**
 * What an item is made of, from a date.
 *
 * Versioned rather than edited: a production order that consumed four of something is not
 * wrong because the recipe now says three. The one in force on a date is the latest
 * version whose `effective_from` has arrived.
 */
export const compositions = pgTable(
  'compositions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    parentItemId: uuid('parent_item_id').notNull(),
    version: integer('version').notNull(),
    realisation: text('realisation').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    definedBy: text('defined_by').notNull(),
    definedAt: timestamp('defined_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('compositions_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('compositions_parent_version_key').on(
      table.tenantId,
      table.parentItemId,
      table.version,
    ),
    index('compositions_parent_effective_idx').on(
      table.tenantId,
      table.parentItemId,
      table.effectiveFrom,
    ),
    foreignKey({
      name: 'compositions_tenant_parent_fk',
      columns: [table.tenantId, table.parentItemId],
      foreignColumns: [catalogItems.tenantId, catalogItems.id],
    }),
  ],
)

export const compositionLines = pgTable(
  'composition_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    compositionId: uuid('composition_id').notNull(),
    componentItemId: uuid('component_item_id').notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.compositionId, table.componentItemId] }),
    index('composition_lines_component_idx').on(table.tenantId, table.componentItemId),
    foreignKey({
      name: 'composition_lines_composition_fk',
      columns: [table.tenantId, table.compositionId],
      foreignColumns: [compositions.tenantId, compositions.id],
    }),
    foreignKey({
      name: 'composition_lines_tenant_component_fk',
      columns: [table.tenantId, table.componentItemId],
      foreignColumns: [catalogItems.tenantId, catalogItems.id],
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

/**
 * Append-only, hash-chained per tenant (ADR 0025).
 *
 * Append-only is enforced twice: \`REVOKE UPDATE, DELETE\` from the application role and a
 * trigger that raises on UPDATE, DELETE or TRUNCATE. The second exists so that if the
 * privileges are ever restored by mistake — a careless \`GRANT ALL\`, a restored dump —
 * the prohibition still holds.
 *
 * \`sequence\` is per tenant and gapless, so the verifier can walk a chain in order and
 * name the first broken link; the primary key on \`(tenant_id, sequence)\` is what makes
 * two concurrent writers claiming the same predecessor a failed transaction rather than a
 * forked chain.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    requestId: text('request_id'),
    traceId: text('trace_id'),
    sourceIp: text('source_ip'),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    /** Which members were removed before hashing — and it is inside the hash (ADR 0025). */
    redacted: jsonb('redacted').$type<string[]>().notNull().default([]),
    previousHash: text('previous_hash').notNull(),
    hash: text('hash').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.sequence] }),
    uniqueIndex('audit_log_id_key').on(table.id),
    index('audit_log_tenant_subject_idx').on(table.tenantId, table.subjectType, table.subjectId),
  ],
)
