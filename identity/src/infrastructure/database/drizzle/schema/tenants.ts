import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * The tenant row itself is tenant-scoped: its policy is `id = current_tenant`, the same
 * shape every other table uses, with no exception carved out for the table that defines
 * the concept. Creating a tenant opens the context on the id it just generated
 * (see `CreateTenantUseCase`), so even the first write in a tenant's life goes through
 * the same door as every write after it.
 *
 * RLS, policies, `FORCE`, grants and the append-only guards live in
 * `migrations/0001_tenant_isolation.sql` rather than here: drizzle-kit generates DDL for
 * table shape, and the isolation guarantees are not table shape.
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  timezone: text('timezone').notNull(),
  status: text('status').notNull().default('active'),
  // Who the workspace legally is. Filled in after creation, so every column is nullable
  // except the currency it reports in, which has a default rather than a guess.
  legalName: text('legal_name'),
  tradeName: text('trade_name'),
  taxId: text('tax_id'),
  stateRegistration: text('state_registration'),
  municipalRegistration: text('municipal_registration'),
  addressLine: text('address_line'),
  addressCity: text('address_city'),
  addressMunicipalityCode: text('address_municipality_code'),
  addressState: text('address_state'),
  addressPostalCode: text('address_postal_code'),
  addressCountry: text('address_country').notNull().default('BR'),
  baseCurrency: text('base_currency').notNull().default('BRL'),
  fiscalRegime: text('fiscal_regime').notNull().default('not-declared'),
  fiscalProfileRevision: integer('fiscal_profile_revision').notNull().default(0),
  fiscalProfileEffectiveFrom: text('fiscal_profile_effective_from'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
})

/** Per-issuer encryption material for the immutable company profile revision history. */
export const companyProfileKeys = pgTable('company_profile_keys', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  material: text('material').notNull(),
})

export const companyProfileVersions = pgTable(
  'company_profile_versions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => companyProfileKeys.tenantId),
    revision: integer('revision').notNull(),
    effectiveFrom: text('effective_from').notNull(),
    ciphertext: text('ciphertext').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('company_profile_versions_revision_key').on(table.tenantId, table.revision),
  ],
)

/**
 * Slug → tenant id, and **deliberately not tenant-scoped** (ADR 0037).
 *
 * Someone typing a workspace handle into a login form has no tenant context yet — this is
 * the lookup that establishes it. So it is its own table holding two columns and nothing
 * else, rather than an RLS exception on `tenants` that would silently also apply to the
 * tenant's name, its timezone, and every column added to it later.
 */
export const tenantDirectory = pgTable('tenant_directory', {
  slug: text('slug').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .unique()
    .references(() => tenants.id),
})
