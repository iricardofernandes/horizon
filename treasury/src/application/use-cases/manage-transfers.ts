import { type Either, left, right } from '@/core/either'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { APPROVE_TRANSFER } from '@/domain/controls/duties'
import { Transfer } from '@/domain/entities/transfer'
import type { TransferApprovalPolicy } from '@/domain/repositories/treasury-repositories'
import { BusinessDate, Currency, Memo, Money, Reason } from '@/domain/value-objects/treasury-values'
import type { Clock } from '../ports/clock'
import type { TreasuryUnitOfWork } from '../ports/unit-of-work'
import {
  audit,
  type CommandContext,
  type Failure,
  type IdempotentContext,
  type Outcome,
  once,
} from './commands'
import { decideWith, onBehalfOf, resolveAuthorities } from './delegations'

export interface TransferInput {
  readonly fromAccountId: string
  readonly toAccountId: string
  readonly amount: string
  readonly fee?: string | undefined
  readonly currency: string
  readonly valueOn: string
  readonly memo?: string | undefined
}

/**
 * Both legs and the fee are appended in the transaction that records the transfer — or, at
 * or above the workspace's threshold for its currency, none until a second person approves
 * it (ADR 0062).
 */
export class PostTransferUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    transfer: TransferInput
  }): Outcome<{ id: string; status: string }> {
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
      const policy = await scope.transferPolicies.find(currency.value.value)
      const approvalRequired = policy !== null && amount.value.amount >= policy.threshold
      const posted = Transfer.post({
        tenantId: context.tenantId,
        from,
        to,
        amount: amount.value,
        fee: fee.value,
        valueOn: valueOn.value,
        memo: memo.value,
        now,
        requestedBy: context.actor,
        approvalRequired,
      })
      if (posted.isLeft()) return left(posted.value)
      await scope.transfers.create(posted.value.transfer)
      await scope.journal.append(posted.value.legs)
      await audit(scope, context, {
        action: approvalRequired ? 'transfer.requested' : 'transfer.posted',
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
      return right({
        id: posted.value.transfer.id.toString(),
        status: posted.value.transfer.status,
      })
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

/** At or above the threshold, a transfer in this currency waits for a second person. */
export class DefineTransferApprovalPolicyUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: CommandContext
    currency: string
    threshold: string
  }): Promise<Either<InvalidInputError, TransferApprovalPolicy>> {
    const currency = Currency.create(request.currency)
    if (currency.isLeft()) return left(currency.value)
    if (!/^\d{1,18}$/.test(request.threshold))
      return left(new InvalidInputError('/threshold', 'must be an integer count of minor units'))
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const policy: TransferApprovalPolicy = {
        currency: currency.value.value,
        threshold: BigInt(request.threshold),
        updatedAt: this.clock.now(),
      }
      await scope.transferPolicies.save(policy)
      await audit(scope, context, {
        action: 'policy.defined',
        subjectType: 'policy',
        subjectId: context.tenantId,
        occurredAt: policy.updatedAt,
        details: { subject: 'transfer', currency: policy.currency, threshold: policy.threshold },
      })
      return right(policy)
    })
  }
}

/**
 * Deciding a transfer that waits (ADR 0062). Approving writes its legs and announces it;
 * whoever asked for it never decides it, in person or through a delegation they lent.
 */
export class DecideTransferUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  approve(context: CommandContext, transferId: string): Outcome<{ id: string; status: string }> {
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const transfer = await scope.transfers.findForUpdate(transferId)
      if (!transfer) return left(new ResourceNotFoundError('transfer was not found'))
      const accounts = await scope.accounts.findForUpdate([
        transfer.fromAccountId,
        transfer.toAccountId,
      ])
      const from = accounts.find((account) => account.id.toString() === transfer.fromAccountId)
      const to = accounts.find((account) => account.id.toString() === transfer.toAccountId)
      if (!from || !to) return left(new ResourceNotFoundError('account was not found'))
      const now = this.clock.now()
      const authorities = await resolveAuthorities(scope, context, APPROVE_TRANSFER, now)
      if (authorities.isLeft()) return left(authorities.value)
      let legs: Awaited<ReturnType<typeof scope.journal.findLegsOf>> = []
      const decided = decideWith<Failure>(authorities.value, (authority) => {
        const written = transfer.approve(authority, { from, to }, now)
        if (written.isLeft()) return left(written.value)
        legs = written.value
        return right(undefined)
      })
      if (decided.isLeft()) return left(decided.value)
      await scope.transfers.save(transfer)
      await scope.journal.append(legs)
      await audit(scope, context, {
        action: 'transfer.approved',
        subjectType: 'transfer',
        subjectId: transferId,
        occurredAt: now,
        details: { amount: transfer.amount.amount, ...onBehalfOf(decided.value) },
      })
      return right({ id: transferId, status: transfer.status })
    })
  }

  reject(
    context: CommandContext,
    transferId: string,
    reason: string,
  ): Outcome<{ id: string; status: string }> {
    const parsed = Reason.create(reason)
    if (parsed.isLeft()) return Promise.resolve(left(parsed.value))
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const transfer = await scope.transfers.findForUpdate(transferId)
      if (!transfer) return left(new ResourceNotFoundError('transfer was not found'))
      const now = this.clock.now()
      const authorities = await resolveAuthorities(scope, context, APPROVE_TRANSFER, now)
      if (authorities.isLeft()) return left(authorities.value)
      const decided = decideWith(authorities.value, (authority) =>
        transfer.reject(authority, parsed.value, now),
      )
      if (decided.isLeft()) return left(decided.value)
      await scope.transfers.save(transfer)
      await audit(scope, context, {
        action: 'transfer.rejected',
        subjectType: 'transfer',
        subjectId: transferId,
        occurredAt: now,
        details: { reason: parsed.value.value, ...onBehalfOf(decided.value) },
      })
      return right({ id: transferId, status: transfer.status })
    })
  }
}
