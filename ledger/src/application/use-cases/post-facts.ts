import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { type DraftLine, JournalTransaction } from '@/domain/entities/journal-transaction'
import type { LedgerAccount } from '@/domain/entities/ledger-account'
import { type Fact, type PostingPlan, planPosting } from '@/domain/services/posting-rules'
import {
  BusinessDate,
  Currency,
  Memo,
  Money,
  Period,
  Reason,
  Reference,
} from '@/domain/value-objects/ledger-values'
import type { Clock } from '../ports/clock'
import type { LedgerScope } from '../ports/unit-of-work'

export type PostingOutcome =
  | { readonly status: 'posted'; readonly transactionId: string }
  | { readonly status: 'pending'; readonly reason: string }
  | { readonly status: 'known'; readonly transactionId: string | null }

/**
 * Turn one fact from another module into a balanced transaction.
 *
 * Every refusal the workspace could fix — a category with no account, a month already
 * closed — leaves the fact `pending` with the numbers it arrived with, rather than
 * throwing. A queue that retries an unmapped category forever is a queue that stops, and a
 * fact dropped because nobody had configured an account is a hole in the books.
 */
export class PostFactUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(scope: LedgerScope, fact: Fact): Promise<PostingOutcome> {
    const known = await scope.facts.find(fact.kind, fact.id)
    if (known && known.status !== 'pending')
      return { status: 'known', transactionId: known.transactionId }
    const now = this.clock.now()
    if (!known)
      await scope.facts.record({
        kind: fact.kind,
        factId: fact.id,
        status: 'pending',
        transactionId: null,
        reference: fact.reference,
        reason: null,
        fact,
        receivedAt: now,
      })
    const posted = await this.attempt(scope, fact, now)
    if (posted.isLeft()) {
      await scope.facts.update(fact.kind, fact.id, {
        status: 'pending',
        reason: posted.value.message,
      })
      return { status: 'pending', reason: posted.value.message }
    }
    await scope.facts.update(fact.kind, fact.id, {
      status: 'posted',
      transactionId: posted.value,
      reason: null,
    })
    return { status: 'posted', transactionId: posted.value }
  }

  private async attempt(
    scope: LedgerScope,
    fact: Fact,
    now: Date,
  ): Promise<Either<ConflictError | InvalidInputError, string>> {
    const plan = planPosting(fact, await scope.mappings.chart())
    if (plan.isLeft()) return left(plan.value)
    const prepared = await prepare(scope, plan.value)
    if (prepared.isLeft()) return left(prepared.value)
    const postedOn = BusinessDate.create(plan.value.postedOn, '/postedOn')
    if (postedOn.isLeft()) return left(postedOn.value)
    const period = Period.of(postedOn.value).value
    await scope.lockPeriod(period)
    if (await scope.periods.isClosed(period))
      return left(new ConflictError(`period ${period} is closed`))
    const reference = Reference.create(plan.value.reference)
    if (reference.isLeft()) return left(reference.value)
    const transaction = JournalTransaction.post({
      tenantId: scope.tenantId,
      reference: reference.value,
      postedOn: postedOn.value,
      currency: prepared.value.currency,
      source: plan.value.source,
      memo: null,
      lines: prepared.value.lines,
      now,
    })
    if (transaction.isLeft()) return left(transaction.value)
    await scope.journal.post(transaction.value)
    return right(transaction.value.id.toString())
  }
}

/** Load every account the plan names and check each one still takes what it is given. */
async function prepare(
  scope: LedgerScope,
  plan: PostingPlan,
): Promise<Either<ConflictError | InvalidInputError, { currency: Currency; lines: DraftLine[] }>> {
  const currency = Currency.create(plan.currency)
  if (currency.isLeft()) return left(currency.value)
  const ids = [...new Set(plan.lines.map((line) => line.accountId))]
  const accounts = new Map<string, LedgerAccount>(
    (await scope.accounts.findMany(ids)).map((account) => [account.id.toString(), account]),
  )
  const lines: DraftLine[] = []
  for (const line of plan.lines) {
    const account = accounts.get(line.accountId)
    if (!account) return left(new ConflictError('a mapped account no longer exists'))
    const amount = Money.of(line.amount, currency.value)
    const accepted = account.accepts(amount)
    if (accepted.isLeft()) return left(accepted.value)
    const memo = Memo.create(line.memo ?? undefined, '/memo')
    if (memo.isLeft()) return left(memo.value)
    lines.push({
      accountId: line.accountId,
      accountCode: account.code,
      side: line.side,
      amount,
      memo: memo.value,
    })
  }
  return right({ currency: currency.value, lines })
}

export type ReversalOutcome =
  | { readonly status: 'reversed'; readonly transactionId: string }
  | { readonly status: 'nothing-to-reverse' }

/**
 * Undo what a fact posted, because the module that reported it undid the fact.
 *
 * A fact still pending has nothing to undo, so it is marked ignored and never replayed: the
 * workspace mapping an account later must not resurrect a reversed sale.
 */
export class ReverseFactUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: LedgerScope,
    kind: Fact['kind'],
    factId: string,
    why: string,
  ): Promise<Either<ConflictError | InvalidInputError | ResourceNotFoundError, ReversalOutcome>> {
    const known = await scope.facts.find(kind, factId)
    if (!known) return right({ status: 'nothing-to-reverse' })
    if (known.status === 'pending' || known.status === 'ignored') {
      await scope.facts.update(kind, factId, { status: 'ignored', reason: why })
      return right({ status: 'nothing-to-reverse' })
    }
    if (known.status === 'reversed' || !known.transactionId)
      return right({ status: 'nothing-to-reverse' })
    const reason = Reason.create(why)
    if (reason.isLeft()) return left(reason.value)
    const original = await scope.journal.findForUpdate(known.transactionId)
    if (!original) return left(new ResourceNotFoundError('the posted transaction is missing'))
    // Redelivery under a new event id finds it already reversed; that is success, not a
    // conflict, or the message would be retried until it reached a dead-letter queue.
    if (original.status === 'reversed') {
      await scope.facts.update(kind, factId, { status: 'reversed' })
      return right({ status: 'nothing-to-reverse' })
    }
    await scope.lockPeriod(original.period)
    if (await scope.periods.isClosed(original.period))
      return left(new ConflictError(`period ${original.period} is closed`))
    const reversal = original.reverse(reason.value, this.clock.now())
    if (reversal.isLeft()) return left(reversal.value)
    await scope.journal.post(reversal.value)
    await scope.journal.save(original)
    await scope.facts.update(kind, factId, { status: 'reversed', reason: why })
    return right({ status: 'reversed', transactionId: reversal.value.id.toString() })
  }
}
