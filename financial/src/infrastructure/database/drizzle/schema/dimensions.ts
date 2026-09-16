import {
  boolean,
  foreignKey,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/** Created lazily inside the tenant's own transaction; RLS and grants live in the migration. */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
})

const audit = {
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
}

export const financialCategories = pgTable(
  'financial_categories',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    nature: text('nature').notNull(),
    parentId: uuid('parent_id'),
    depth: smallint('depth').notNull(),
    ...audit,
  },
  (table) => [
    uniqueIndex('financial_categories_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('financial_categories_tenant_code_key').on(table.tenantId, table.code),
    foreignKey({
      name: 'financial_categories_parent_fk',
      columns: [table.tenantId, table.parentId],
      foreignColumns: [table.tenantId, table.id],
    }),
  ],
)

export const analyticDimensions = pgTable(
  'analytic_dimensions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    ...audit,
  },
  (table) => [
    uniqueIndex('analytic_dimensions_tenant_kind_code_key').on(
      table.tenantId,
      table.kind,
      table.code,
    ),
  ],
)

export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    ...audit,
  },
  (table) => [uniqueIndex('payment_methods_tenant_code_key').on(table.tenantId, table.code)],
)

export const paymentTerms = pgTable(
  'payment_terms',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    /** A value object of the term, never queried on its own: `[{ dueInDays, basisPoints }]`. */
    installments: jsonb('installments')
      .$type<{ dueInDays: number; basisPoints: number }[]>()
      .notNull(),
    ...audit,
  },
  (table) => [uniqueIndex('payment_terms_tenant_name_key').on(table.tenantId, table.name)],
)
