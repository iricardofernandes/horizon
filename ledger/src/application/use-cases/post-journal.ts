import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { type DraftLine, JournalTransaction } from '@/domain/entities/journal-transaction'
import type { EntrySide, LedgerAccount } from '@/domain/entities/ledger-account'
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
import type { LedgerScope, LedgerUnitOfWork } from '../ports/unit-of-work'
import { audit, type IdempotentContext, type Outcome, once } from './commands'

export interface LineInput {
  readonly accountId: string
  readonly side: EntrySide
  readonly amount: string
  readonly memo?: string | undefined
}

export interface TransactionInput {
  readonly reference: string
  readonly postedOn: string
  readonly currency: string
  readonly memo?: string | undefined
  readonly lines: readonly LineInput[]
}

interface ParsedTransaction {
  reference: Reference
  postedOn: BusinessDate
  currency: Currency
  memo: Memo | null
  amounts: readonly Money[]
  memos: readonly (Memo | null)[]
}

function parse(input: TransactionInput): Either<InvalidInputError, ParsedTransaction> {
  const reference = Reference.create(input.reference)
  if (reference.isLeft()) return left(reference.value)
  const postedOn = BusinessDate.create(input.postedOn, '/postedOn')
  if (postedOn.isLeft()) return left(postedOn.value)
  const currency = Currency.create(input.currency)
  if (currency.isLeft()) return left(currency.value)
  const memo = Memo.create(input.memo, '/memo')
  if (memo.isLeft()) return left(memo.value)
  const amounts: Money[] = []
  const memos: (Memo | null)[] = []
  for (const [index, line] of input.lines.entries()) {
    const amount = Money.create(line.amount, currency.value, `/lines/${index}/amount`)
    if (amount.isLeft()) return left(amount.value)
    const lineMemo = Memo.create(line.memo, `/lines/${index}/memo`)
    if (lineMemo.isLeft()) return left(lineMemo.value)
    amounts.push(amount.value)
    memos.push(lineMemo.value)
  }
  return right({
    reference: reference.value,
    postedOn: postedOn.value,
    currency: currency.value,
    memo: memo.value,
    amounts,
    memos,
  })
}

/** Every named account, loaded once and checked against the amount it is about to take. */
async function resolveLines(
  scope: LedgerScope,
  input: TransactionInput,
  parsed: ParsedTransaction,
): Promise<Either<ConflictError | ResourceNotFoundError, readonly DraftLine[]>> {
  const ids = [...new Set(input.lines.map((line) => line.accountId))]
  const accounts = new Map<string, LedgerAccount>(
    (await scope.accounts.findMany(ids)).map((account) => [account.id.toString(), account]),
  )
  const lines: DraftLine[] = []
  for (const [index, line] of input.lines.entries()) {
    const account = accounts.get(line.accountId)
    if (!account)
      return left(new ResourceNotFoundError(`account of line ${index + 1} was not found`))
    const amount = parsed.amounts[index]
    if (!amount) return left(new ConflictError('a line lost its amount'))
    const accepted = account.accepts(amount)
    if (accepted.isLeft()) return left(accepted.value)
    lines.push({
      accountId: line.accountId,
      accountCode: account.code,
      side: line.side,
      amount,
      memo: parsed.memos[index] ?? null,
    })
  }
  return right(lines)
}

/** A closed month takes nothing, and refuses it before any work is done. */
async function requireOpen(
  scope: LedgerScope,
  period: string,
): Promise<Either<ConflictError, void>> {
  await scope.lockPeriod(period)
  if (await scope.periods.isClosed(period))
    return left(new ConflictError(`period ${period} is closed`))
  return right(undefined)
}

/** Post a balanced transaction into an open month. */
export class PostTransactionUseCase {
  constructor(
    private readonly unitOfWork: LedgerUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    transaction: TransactionInput
  }): Outcome<{ id: string; period: string; total: string }> {
    const parsed = parse(request.transaction)
    if (parsed.isLeft()) return left(parsed.value)
    const values = parsed.value
    const { context } = request
    return once(
      this.unitOfWork,
      context,
      'transaction.post',
      request.transaction,
      async (scope) => {
        const period = Period.of(values.postedOn).value
        const open = await requireOpen(scope, period)
        if (open.isLeft()) return left(open.value)
        const lines = await resolveLines(scope, request.transaction, values)
        if (lines.isLeft()) return left(lines.value)
        const now = this.clock.now()
        const posted = JournalTransaction.post({
          tenantId: context.tenantId,
          reference: values.reference,
          postedOn: values.postedOn,
          currency: values.currency,
          source: { type: 'manual', id: null },
          memo: values.memo,
          lines: lines.value,
          now,
        })
        if (posted.isLeft()) return left(posted.value)
        await scope.journal.post(posted.value)
        await audit(scope, context, {
          action: 'transaction.posted',
          subjectType: 'transaction',
          subjectId: posted.value.id.toString(),
          occurredAt: now,
          details: {
            reference: values.reference.value,
            postedOn: values.postedOn.value,
            period,
            total: posted.value.total.amount,
            lineCount: lines.value.length,
          },
        })
        return right({
          id: posted.value.id.toString(),
          period,
          total: posted.value.total.amount.toString(),
        })
      },
    )
  }
}

/**
 * Undo a transaction with its mirror. Both months have to be open: the one the mistake
 * landed in, and the one the correction lands in when it is dated later.
 */
export class ReverseTransactionUseCase {
  constructor(
    private readonly unitOfWork: LedgerUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    transactionId: string
    reason: string
    reversalOn?: string | undefined
  }): Outcome<{ id: string; period: string }> {
    const reason = Reason.create(request.reason)
    if (reason.isLeft()) return left(reason.value)
    let on: BusinessDate | null = null
    if (request.reversalOn !== undefined) {
      const parsed = BusinessDate.create(request.reversalOn, '/reversalOn')
      if (parsed.isLeft()) return left(parsed.value)
      on = parsed.value
    }
    const { context } = request
    const fingerprint = {
      transactionId: request.transactionId,
      reason: request.reason,
      reversalOn: request.reversalOn ?? null,
    }
    return once(this.unitOfWork, context, 'transaction.reverse', fingerprint, async (scope) => {
      const original = await scope.journal.findForUpdate(request.transactionId)
      if (!original) return left(new ResourceNotFoundError('transaction was not found'))
      if (on && on.value < original.postedOn)
        return left(new ConflictError('a reversal cannot be dated before the transaction'))
      for (const period of periodsTouched(original.period, on)) {
        const open = await requireOpen(scope, period)
        if (open.isLeft()) return left(open.value)
      }
      const now = this.clock.now()
      const reversal = original.reverse(reason.value, now, on ? { reversalOn: on } : {})
      if (reversal.isLeft()) return left(reversal.value)
      await scope.journal.post(reversal.value)
      await scope.journal.save(original)
      await audit(scope, context, {
        action: 'transaction.reversed',
        subjectType: 'transaction',
        subjectId: request.transactionId,
        occurredAt: now,
        details: { reversalId: reversal.value.id.toString(), reason: reason.value.value },
      })
      return right({ id: reversal.value.id.toString(), period: reversal.value.period })
    })
  }
}

/** The months a reversal affects: the original's, and the correction's when it differs. */
function periodsTouched(originalPeriod: string, reversalOn: BusinessDate | null): string[] {
  const target = reversalOn ? Period.of(reversalOn).value : originalPeriod
  return target === originalPeriod ? [originalPeriod] : [originalPeriod, target]
}
