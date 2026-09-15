import { index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './tenants'

/** Global credentials, readable only after app.current_account has been established. */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  status: text('status').notNull().default('active'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
})

/** A keyed blind index is the only globally readable account locator. */
export const accountDirectory = pgTable('account_directory', {
  emailIndex: text('email_index').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .unique()
    .references(() => accounts.id),
})

/** Selection projection. Roles remain on the tenant-scoped users aggregate. */
export const accountMemberships = pgTable(
  'account_memberships',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id').notNull(),
    workspaceSlug: text('workspace_slug').notNull(),
    workspaceName: text('workspace_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.tenantId] }),
    uniqueIndex('account_memberships_tenant_user_key').on(table.tenantId, table.userId),
    index('account_memberships_account_idx').on(table.accountId, table.workspaceName),
  ],
)
