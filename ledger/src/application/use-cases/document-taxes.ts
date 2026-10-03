import type { DocumentOutcome } from '@/domain/repositories/ledger-repositories'
import type { Fact } from '@/domain/services/posting-rules'
import type { Clock } from '../ports/clock'
import type { LedgerScope } from '../ports/unit-of-work'
import type { PostFactUseCase, ReverseFactUseCase } from './post-facts'

type TaxLock = Extract<Fact, { kind: 'tax-lock' }>

export type DocumentTaxesOutcome =
  | { readonly status: 'held' }
  | { readonly status: 'posted'; readonly transactionId: string }
  | { readonly status: 'pending'; readonly reason: string }
  | { readonly status: 'reversed'; readonly transactionId: string }
  | { readonly status: 'nothing-to-do' }

/**
 * A document's taxes follow the authority's answer (Phase 91, ADR 0076).
 *
 * The lock Fiscal publishes waits as a `held` fact, keyed by its document. The document's
 * authorization posts it, and its cancellation reverses what was posted; a rejected
 * document never posts, and its corrected successor is a document of its own. The lock and
 * the answer may arrive in either order, so the answer is kept and the lock looks it up.
 */
export class DocumentTaxesUseCase {
  constructor(
    private readonly post: PostFactUseCase,
    private readonly reverse: ReverseFactUseCase,
    private readonly clock: Clock,
  ) {}

  /** The lock: posted at once if its document was already authorized, held otherwise. */
  async locked(scope: LedgerScope, fact: TaxLock): Promise<DocumentTaxesOutcome> {
    if (await scope.facts.find(fact.kind, fact.id)) return { status: 'nothing-to-do' }
    const answer = await scope.documentOutcomes.find(fact.id)
    if (answer === 'authorized') return this.post.executeInScope(scope, fact).then(settled)
    await scope.facts.record({
      kind: fact.kind,
      factId: fact.id,
      status: answer ? 'ignored' : 'held',
      transactionId: null,
      reference: fact.reference,
      reason: answer ? `the document was ${answer}` : 'awaiting the authority',
      fact,
      receivedAt: this.clock.now(),
    })
    return answer ? { status: 'nothing-to-do' } : { status: 'held' }
  }

  /**
   * The authority's answer for a document. An authorization posts its held lock; a rejection
   * or a cancellation undoes whatever the lock became. An answer the document cannot take any
   * more, such as an authorization after a cancellation, changes nothing.
   */
  async decided(
    scope: LedgerScope,
    documentId: string,
    outcome: DocumentOutcome,
    observedAt: Date,
  ): Promise<DocumentTaxesOutcome> {
    const answer = await scope.documentOutcomes.record(documentId, outcome, observedAt)
    if (answer !== outcome) return { status: 'nothing-to-do' }
    const known = await scope.facts.find('tax-lock', documentId)
    if (!known) return { status: 'nothing-to-do' }
    if (answer === 'authorized') {
      if (known.status !== 'held') return { status: 'nothing-to-do' }
      // From here the lock is an ordinary fact: posted now, or pending until the workspace
      // maps an account or reopens the month, and replayed then.
      await scope.facts.update(known.kind, known.factId, { status: 'pending', reason: null })
      return this.post.executeInScope(scope, known.fact).then(settled)
    }
    const undone = await this.reverse.executeInScope(
      scope,
      'tax-lock',
      documentId,
      `the document was ${answer}`,
    )
    // A reversal the books cannot take, such as one into a closed month, is thrown, so the
    // answer is redelivered until it can be (as every other reversal).
    if (undone.isLeft()) throw undone.value
    return undone.value.status === 'reversed'
      ? { status: 'reversed', transactionId: undone.value.transactionId }
      : { status: 'nothing-to-do' }
  }
}

function settled(
  outcome: Awaited<ReturnType<PostFactUseCase['executeInScope']>>,
): DocumentTaxesOutcome {
  if (outcome.status === 'known') return { status: 'nothing-to-do' }
  return outcome
}
