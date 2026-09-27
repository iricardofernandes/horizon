import { BusinessDate } from '@/domain/value-objects/crm-values'
import type { Clock } from '../ports/clock'
import type { CrmScope } from '../ports/unit-of-work'
import { audit } from './commands'

/** Who records the conversion in the opportunity's history: the quote's acceptance. */
export const QUOTE_ACCEPTANCE = 'sales:quote-accepted'

export interface QuoteFact {
  readonly status: 'sent' | 'accepted' | 'rejected'
  readonly quoteId: string
  readonly quoteRoot: string
  readonly quoteVersion: number
  readonly total: { readonly amount: string; readonly currency: string } | null
  readonly occurredAt: Date
  readonly attribution: { readonly opportunityId: string } | null | undefined
}

export type FollowOutcome = 'ignored' | 'linked' | 'converted'

/**
 * Follow a Sales quote made for an opportunity (Phase 58). CRM links every version it
 * hears of, and an accepted one converts the opportunity: won, at the quote's total. CRM
 * reads this from events only; it never calls or writes Sales.
 */
export class FollowQuoteUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(scope: CrmScope, fact: QuoteFact): Promise<FollowOutcome> {
    if (!fact.attribution) return 'ignored'
    const { opportunityId } = fact.attribution
    const opportunity = await scope.opportunities.findById(opportunityId)
    if (!opportunity) return 'ignored'
    await scope.quotes.record({
      opportunityId,
      quoteRoot: fact.quoteRoot,
      quoteId: fact.quoteId,
      quoteVersion: fact.quoteVersion,
      status: fact.status,
      total: fact.total,
      seenAt: fact.occurredAt,
    })
    if (fact.status !== 'accepted' || !fact.total) return 'linked'
    const now = this.clock.now()
    const converted = opportunity.convert(
      {
        quoteId: fact.quoteId,
        quoteRoot: fact.quoteRoot,
        quoteVersion: fact.quoteVersion,
        value: fact.total,
      },
      BusinessDate.of(fact.occurredAt),
      QUOTE_ACCEPTANCE,
      now,
    )
    if (!converted) return 'linked'
    await scope.opportunities.save(opportunity)
    await audit(
      scope,
      { tenantId: scope.tenantId, actor: QUOTE_ACCEPTANCE, requestId: null },
      {
        action: 'opportunity.converted',
        subjectType: 'opportunity',
        subjectId: opportunityId,
        occurredAt: now,
        details: {
          quoteId: fact.quoteId,
          quoteRoot: fact.quoteRoot,
          version: opportunity.state.version,
        },
      },
    )
    return 'converted'
  }
}
