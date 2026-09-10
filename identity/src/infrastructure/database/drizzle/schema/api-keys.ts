import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenants } from './tenants'
import { users } from './users'

/**
 * `hz_<env>_<prefix>_<secret>` (ADR 0022), stored in the only two halves that make sense:
 *
 *   - `prefix` in **plaintext and indexed** — identifying, never usable. A key found in a
 *     log can be traced and revoked without its holder producing it, and authentication
 *     is one indexed equality before any Argon2id cost is paid.
 *   - `secret_hash` — Argon2id, never stored, logged or displayed after creation.
 *
 * The prefix index is unique **globally**, not per tenant. Authentication presents a
 * credential with no tenant context attached, so a prefix that could repeat across tenants
 * would make the lookup ambiguous at precisely the moment there is nothing to disambiguate
 * it with. With 24 characters of base62 that is free.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    issuedBy: uuid('issued_by').notNull(),
    name: text('name').notNull(),
    environment: text('environment').notNull(),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    status: text('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    supersededAt: timestamp('superseded_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'api_keys_tenant_issuer_fk',
      columns: [table.tenantId, table.issuedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    uniqueIndex('api_keys_prefix_key').on(table.prefix),
    index('api_keys_tenant_keyset_idx').on(table.tenantId, table.createdAt, table.id),
    index('api_keys_tenant_issuer_idx').on(table.tenantId, table.issuedBy),
  ],
)
