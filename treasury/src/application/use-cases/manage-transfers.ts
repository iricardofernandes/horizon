import { left, right } from '@/core/either'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { Transfer } from '@/domain/entities/transfer'
import { BusinessDate, Currency, Memo, Money, Reason } from '@/domain/value-objects/treasury-values'
import type { Clock } from '../ports/clock'
import type { TreasuryUnitOfWork } from '../ports/unit-of-work'
import { audit, type IdempotentContext, type Outcome, once } from './commands'

export interface TransferInput {
  readonly fromAccountId: string
  readonly toAccountId: string
  readonly amount: string
  readonly fee?: string | undefined
  readonly currency: string
  readonly valueOn: string
  readonly memo?: string | undefined
}

/** Both legs and the fee are appended in the transaction that records the transfer. */
export class PostTransferUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    transfer: TransferInput
  }): Outcome<{ id: string }> {
    const input = request.transfer
    const currency = Currency.create(input.currency)
    if (currency.isLeft()) return left(currency.value)
    const amount = Money.create(input.amount, currency.value)
    if (amount.isLeft()) return left(amount.value)
    const fee = Money.create(input.fee ?? '0', currency.value, '/fee')
    if (fee.isLeft()) return left(fee.value)
    const valueOn = BusinessDate.create(input.valueOn, '/valueOn')
    if (valueOn.isLeft()) return left(valueOn.value)
    const memo = Memo.create(input.memo, '/memo')
    if (memo.isLeft()) return left(memo.value)
    const { context } = request
    return once(this.unitOfWork, context, 'transfer.post', input, async (scope) => {
      const accounts = await scope.accounts.findForUpdate([input.fromAccountId, input.toAccountId])
      const from = accounts.find((account) => account.id.toString() === input.fromAccountId)
      const to = accounts.find((account) => account.id.toString() === input.toAccountId)
      if (!from || !to) return left(new ResourceNotFoundError('account was not found'))
      const now = this.clock.now()
      const posted = Transfer.post({
        tenantId: context.tenantId,
        from,
        to,
        amount: amount.value,
        fee: fee.value,
        valueOn: valueOn.value,
        memo: memo.value,
        now,
      })
      if (posted.isLeft()) return left(posted.value)
      await scope.transfers.create(posted.value.transfer)
      await scope.journal.append(posted.value.legs)
      await audit(scope, context, {
        action: 'transfer.posted',
        subjectType: 'transfer',
        subjectId: posted.value.transfer.id.toString(),
        occurredAt: now,
        details: {
          fromAccountId: input.fromAccountId,
          toAccountId: input.toAccountId,
          amount: amount.value.amount,
          fee: fee.value.amount,
        },
      })
      return right({ id: posted.value.transfer.id.toString() })
    })
  }
}

export class CancelTransferUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    transferId: string
    reason: string
  }): Outcome<{ id: string }> {
    const reason = Reason.create(request.reason)
    if (reason.isLeft()) return left(reason.value)
    const { context } = request
    const fingerprint = { transferId: request.transferId, reason: request.reason }
    return once(this.unitOfWork, context, 'transfer.cancel', fingerprint, async (scope) => {
      const transfer = await scope.transfers.findForUpdate(request.transferId)
      if (!transfer) return left(new ResourceNotFoundError('transfer was not found'))
      await scope.accounts.findForUpdate([transfer.fromAccountId, transfer.toAccountId])
      const legs = await scope.journal.findLegsOf(request.transferId)
      const now = this.clock.now()
      const inverses = transfer.cancel(legs, reason.value, now)
      if (inverses.isLeft()) return left(inverses.value)
      await scope.transfers.save(transfer)
      await scope.journal.append(inverses.value)
      await audit(scope, context, {
        action: 'transfer.cancelled',
        subjectType: 'transfer',
        subjectId: request.transferId,
        occurredAt: now,
        details: { reason: reason.value.value },
      })
      return right({ id: request.transferId })
    })
  }
}
