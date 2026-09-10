import { sql } from 'drizzle-orm'
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
import { dataSubjectKeys } from './data-subject-keys'
import { tenants } from './tenants'

/**
 * Personal data is stored encrypted under the subject's own key (ADR 0026), which is why
 * the columns are named for what they hold rather than for what they mean:
 *
 *   - `email_ciphertext` and `name_ciphertext` are AES-256-GCM under the row's
 *     data-subject key. They cannot be indexed, searched, sorted or joined. That is the
 *     substantial cost of crypto-shredding, and the schema is designed around it rather
 *     than working around it.
 *   - `email_index` is a **blind index**: a keyed HMAC of the normalised address under a
 *     service-wide key. It supports exact-match lookup, which is what logging in needs,
 *     and nothing else — no range query, no prefix search, no "users at this domain".
 *
 * `roles` is `jsonb` holding opaque `{ module, role }` pairs. Not a foreign key and not
 * an enum: identity stores assignments it cannot expand, and a database constraint
 * enumerating another module's roles would be exactly the coupling ADR 0023 removes.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    emailCiphertext: text('email_ciphertext').notNull(),
    emailIndex: text('email_index').notNull(),
    nameCiphertext: text('name_ciphertext').notNull(),
    passwordHash: text('password_hash').notNull(),
    roles: jsonb('roles').$type<{ module: string; role: string }[]>().notNull().default([]),
    status: text('status').notNull().default('active'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('users_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({
      name: 'users_tenant_subject_key_fk',
      columns: [table.tenantId, table.id],
      foreignColumns: [dataSubjectKeys.tenantId, dataSubjectKeys.id],
    }),
    // One address per tenant, not per system: the same person may hold accounts in two
    // tenants, and they are different users with different keys.
    uniqueIndex('users_tenant_email_index_key').on(table.tenantId, table.emailIndex),
    // Every composite index leads with tenant_id (ADR 0017) — which is what keeps the
    // per-row policy evaluation cheap rather than a sequential scan behind a filter.
    index('users_tenant_keyset_idx').on(table.tenantId, table.createdAt, table.id),
    index('users_tenant_status_idx').on(table.tenantId, table.status).where(sql`status = 'active'`),
  ],
)
