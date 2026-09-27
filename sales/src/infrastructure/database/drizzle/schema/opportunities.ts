import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tenants } from './sales'

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/** CRM opportunities as Sales follows them (Phase 58); each field keeps its fact's instant. */
export const opportunityProjections = pgTable(
  'opportunity_projections',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id').notNull(),
    accountId: uuid('account_id').notNull(),
    ownerId: uuid('owner_id'),
    ownerAsOf: instant('owner_as_of'),
    sourceId: uuid('source_id'),
    sourceAsOf: instant('source_as_of'),
    status: text('status'),
    statusAsOf: instant('status_as_of'),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.id] })],
)
