import { eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type {
  OpportunityProjectionsRepository,
  OpportunityView,
} from '@/domain/repositories/sales-repositories'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

const STATUSES = ['open', 'won', 'lost'] as const

/**
 * CRM opportunities as Sales follows them (Phase 58). Each field is set only by a fact at
 * least as recent as the one that set it last, so facts delivered out of order converge
 * on the latest state.
 */
export function opportunityProjectionsRepository(
  tx: Transaction,
  tenantId: string,
): OpportunityProjectionsRepository {
  return {
    find: async (id) => {
      const [row] = await tx
        .select()
        .from(schema.opportunityProjections)
        .where(eq(schema.opportunityProjections.id, id))
        .limit(1)
      if (!row) return null
      const status = STATUSES.find((value) => value === row.status) ?? null
      return {
        id: row.id,
        accountId: row.accountId,
        ownerId: row.ownerId,
        sourceId: row.sourceId,
        status,
      } satisfies OpportunityView
    },
    record: async (update) => {
      const knows = (field: unknown) => field !== undefined
      const owner = knows(update.ownerId) ? (update.ownerId ?? null) : null
      const ownerAt = knows(update.ownerId) ? update.at : null
      const source = knows(update.sourceId) ? (update.sourceId ?? null) : null
      const sourceAt = knows(update.sourceId) ? update.at : null
      const status = update.status ?? null
      const statusAt = update.status ? update.at : null
      const p = schema.opportunityProjections
      // A field moves only when the incoming fact speaks about it and is not older.
      const newer = (incoming: string, current: string) =>
        sql.raw(
          `excluded.${incoming} is not null and (opportunity_projections.${current} is null or excluded.${incoming} >= opportunity_projections.${current})`,
        )
      await tx
        .insert(p)
        .values({
          tenantId,
          id: update.id,
          accountId: update.accountId,
          ownerId: owner,
          ownerAsOf: ownerAt,
          sourceId: source,
          sourceAsOf: sourceAt,
          status,
          statusAsOf: statusAt,
        })
        .onConflictDoUpdate({
          target: [p.tenantId, p.id],
          set: {
            ownerId: sql`case when ${newer('owner_as_of', 'owner_as_of')} then excluded.owner_id else ${p.ownerId} end`,
            ownerAsOf: sql`case when ${newer('owner_as_of', 'owner_as_of')} then excluded.owner_as_of else ${p.ownerAsOf} end`,
            sourceId: sql`case when ${newer('source_as_of', 'source_as_of')} then excluded.source_id else ${p.sourceId} end`,
            sourceAsOf: sql`case when ${newer('source_as_of', 'source_as_of')} then excluded.source_as_of else ${p.sourceAsOf} end`,
            status: sql`case when ${newer('status_as_of', 'status_as_of')} then excluded.status else ${p.status} end`,
            statusAsOf: sql`case when ${newer('status_as_of', 'status_as_of')} then excluded.status_as_of else ${p.statusAsOf} end`,
          },
        })
    },
  }
}
