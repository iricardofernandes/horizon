import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './procurement'

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/** An approval lent to a colleague for a period (ADR 0062). */
export const approvalDelegations = pgTable('approval_delegations', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  permission: text('permission').notNull(),
  delegatorId: text('delegator_id').notNull(),
  delegateId: text('delegate_id').notNull(),
  startsAt: instant('starts_at').notNull(),
  endsAt: instant('ends_at').notNull(),
  reason: text('reason'),
  createdAt: instant('created_at').notNull(),
  revokedAt: instant('revoked_at'),
  revokedBy: text('revoked_by'),
})
