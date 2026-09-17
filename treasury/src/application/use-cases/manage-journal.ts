import { left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { type EntryDirection, JournalEntry } from '@/domain/entities/journal-entry'
import { BusinessDate, Currency, Memo, Money, Reason } from '@/domain/value-objects/treasury-values'
import type { Clock } from '../ports/clock'
import type { TreasuryUnitOfWork } from '../ports/unit-of-work'
import { audit, type IdempotentContext, type Outcome, once } from './commands'

export interface EntryInput {
  readonly direction: EntryDirection
  readonly amount: string
  readonly currency: string
  readonly valueOn: string
  readonly counterparty?: string | undefined
  readonly memo?: string | undefined
}

/** A movement that is not a transfer: a bank fee, interest, a deposit recorded by hand. */
export class RecordEntryUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    accountId: string
    entry: EntryInput
  }): Outcome<{ id: string }> {
    const currency = Currency.create(request.entry.currency)
    if (currency.isLeft()) return left(currency.value)
    const amount = Money.create(request.entry.amount, currency.value)
    if (amount.isLeft()) return left(amount.value)
    const valueOn = BusinessDate.create(request.entry.valueOn, '/valueOn')
    if (valueOn.isLeft()) return left(valueOn.value)
    const counterparty = Memo.create(request.entry.counterparty, '/counterparty')
    if (counterparty.isLeft()) return left(counterparty.value)
    const memo = Memo.create(request.entry.memo, '/memo')
    if (memo.isLeft()) return left(memo.value)
    const { context } = request
    const fingerprint = { accountId: request.accountId, ...request.entry }
    return once(this.unitOfWork, context, 'entry.record', fingerprint, async (scope) => {
      const [account] = await scope.accounts.findForUpdate([request.accountId])
      if (!account) return left(new ResourceNotFoundError('account was not found'))
      const accepted = account.accepts(currency.value, valueOn.value)
      if (accepted.isLeft()) return left(accepted.value)
      const now = this.clock.now()
      const entry = JournalEntry.record({
        tenantId: context.tenantId,
        accountId: request.accountId,
        direction: request.entry.direction,
        amount: amount.value,
        valueOn: valueOn.value,
        source: 'manual',
        transferId: null,
        reverses: null,
        counterparty: counterparty.value,
        memo: memo.value,
        reason: null,
        now,
      })
      if (entry.isLeft()) return left(entry.value)
      await scope.journal.append([entry.value])
      await audit(scope, context, {
        action: 'entry.recorded',
        subjectType: 'entry',
        subjectId: entry.value.id.toString(),
        occurredAt: now,
        details: {
          accountId: request.accountId,
          direction: request.entry.direction,
          amount: amount.value.amount,
          valueOn: valueOn.value.value,
        },
      })
      return right({ id: entry.value.id.toString() })
    })
  }
}

export class ReverseEntryUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    entryId: string
    reason: string
  }): Outcome<{ id: string }> {
    const reason = Reason.create(request.reason)
    if (reason.isLeft()) return left(reason.value)
    const { context } = request
    const fingerprint = { entryId: request.entryId, reason: request.reason }
    return once(this.unitOfWork, context, 'entry.reverse', fingerprint, async (scope) => {
      const entry = await scope.journal.findById(request.entryId)
      if (!entry) return left(new ResourceNotFoundError('entry was not found'))
      if (await scope.journal.findReversalOf(request.entryId))
        return left(new ConflictError('the entry is already reversed'))
      const [account] = await scope.accounts.findForUpdate([entry.accountId])
      if (!account) return left(new ResourceNotFoundError('account was not found'))
      const now = this.clock.now()
      const inverse = entry.reverse(reason.value, now)
      if (inverse.isLeft()) return left(inverse.value)
      await scope.journal.append([inverse.value])
      await audit(scope, context, {
        action: 'entry.reversed',
        subjectType: 'entry',
        subjectId: request.entryId,
        occurredAt: now,
        details: { reversalId: inverse.value.id.toString(), reason: reason.value.value },
      })
      return right({ id: inverse.value.id.toString() })
    })
  }
}
