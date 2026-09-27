import { sql } from 'drizzle-orm'
import type { OpportunityQuotesRepository } from '@/domain/repositories/crm-repositories'
import type { Transaction } from './crm-store'
import * as schema from './schema'

/** A later state of the same version wins; a decision is later than the sending. */
const RANK = sql.raw(
  `(case excluded.status when 'sent' then 1 else 2 end) > (case opportunity_quotes.status when 'sent' then 1 else 2 end)`,
)

/**
 * The quotes made for an opportunity (Phase 58), one row per offer. Events can arrive out
 * of order or twice; the row only moves forward: a newer version, or a decision on the
 * version it already holds.
 */
export function opportunityQuotesRepository(
  tx: Transaction,
  tenantId: string,
): OpportunityQuotesRepository {
  return {
    record: async (link) => {
      const q = schema.opportunityQuotes
      await tx
        .insert(q)
        .values({
          tenantId,
          opportunityId: link.opportunityId,
          quoteRoot: link.quoteRoot,
          quoteId: link.quoteId,
          quoteVersion: link.quoteVersion,
          status: link.status,
          totalAmount: link.total ? BigInt(link.total.amount) : null,
          currency: link.total?.currency ?? null,
          seenAt: link.seenAt,
        })
        .onConflictDoUpdate({
          target: [q.tenantId, q.opportunityId, q.quoteRoot],
          set: {
            quoteId: sql`excluded.quote_id`,
            quoteVersion: sql`excluded.quote_version`,
            status: sql`excluded.status`,
            totalAmount: sql`coalesce(excluded.total_amount, ${q.totalAmount})`,
            currency: sql`coalesce(excluded.currency, ${q.currency})`,
            seenAt: sql`excluded.seen_at`,
          },
          setWhere: sql`excluded.quote_version > ${q.quoteVersion}
            or (excluded.quote_version = ${q.quoteVersion} and ${RANK})`,
        })
    },
  }
}
