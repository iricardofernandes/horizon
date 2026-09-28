import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { APPROVE_ENTRY } from '@/domain/controls/duties'
import { JournalTransaction } from '@/domain/entities/journal-transaction'
import type { ManualEntry } from '@/domain/entities/manual-entry'
import type { EntryApprovalPolicy } from '@/domain/repositories/ledger-repositories'
import { Currency, Period, Reason } from '@/domain/value-objects/ledger-values'
import type { Clock } from '../ports/clock'
import type { LedgerScope, LedgerUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext, type Failure } from './commands'
import { decideWith, onBehalfOf, resolveAuthorities } from './delegations'
import { parse, requireOpen, resolveLines, type TransactionInput } from './post-journal'

/** At or above the threshold, a manual entry in this currency waits for a second person. */
export class DefineEntryApprovalPolicyUseCase {
  constructor(
    private readonly unitOfWork: LedgerUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: CommandContext
    currency: string
    threshold: string
  }): Promise<Either<InvalidInputError, EntryApprovalPolicy>> {
    const currency = Currency.create(request.currency)
    if (currency.isLeft()) return left(currency.value)
    if (!/^\d{1,18}$/.test(request.threshold))
      return left(new InvalidInputError('/threshold', 'must be an integer count of minor units'))
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const policy: EntryApprovalPolicy = {
        currency: currency.value.value,
        threshold: BigInt(request.threshold),
        updatedAt: this.clock.now(),
      }
      await scope.entryPolicies.save(policy)
      await audit(scope, context, {
        action: 'policy.defined',
        subjectType: 'policy',
        subjectId: context.tenantId,
        occurredAt: policy.updatedAt,
        details: {
          subject: 'manual-entry',
          currency: policy.currency,
          threshold: policy.threshold,
        },
      })
      return right(policy)
    })
  }
}

/** The transaction a manual entry describes, checked again now: the month must be open. */
async function transactionOf(
  scope: LedgerScope,
  entry: ManualEntry,
  now: Date,
): Promise<Either<Failure, JournalTransaction>> {
  const input: TransactionInput = {
    reference: entry.terms.reference,
    postedOn: entry.terms.postedOn,
    currency: entry.terms.currency,
    memo: entry.terms.memo ?? undefined,
    lines: entry.terms.lines.map((line) => ({ ...line, memo: line.memo ?? undefined })),
  }
  const values = parse(input)
  if (values.isLeft()) return left(values.value)
  const open = await requireOpen(scope, Period.of(values.value.postedOn).value)
  if (open.isLeft()) return left(open.value)
  const lines = await resolveLines(scope, input, values.value)
  if (lines.isLeft()) return left(lines.value)
  return JournalTransaction.post(
    {
      tenantId: scope.tenantId,
      reference: values.value.reference,
      postedOn: values.value.postedOn,
      currency: values.value.currency,
      source: { type: 'manual', id: null },
      memo: values.value.memo,
      lines: lines.value,
      now,
    },
    new UniqueEntityID(),
  )
}

/**
 * Deciding a manual entry that waits (ADR 0062). Approving posts it; the person who wrote it
 * never decides it, in person or through a delegation they lent.
 */
export class DecideManualEntryUseCase {
  constructor(
    private readonly unitOfWork: LedgerUnitOfWork,
    private readonly clock: Clock,
  ) {}

  approve(
    context: CommandContext,
    entryId: string,
  ): Promise<Either<Failure, { status: string; transactionId: string | null }>> {
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const entry = await scope.manualEntries.findForUpdate(entryId)
      if (!entry) return left(new ResourceNotFoundError('manual entry was not found'))
      const now = this.clock.now()
      const authorities = await resolveAuthorities(scope, context, APPROVE_ENTRY, now)
      if (authorities.isLeft()) return left(authorities.value)
      const transaction = await transactionOf(scope, entry, now)
      if (transaction.isLeft()) return left(transaction.value)
      const transactionId = transaction.value.id.toString()
      const decided = decideWith(authorities.value, (authority) =>
        entry.approve(authority, transactionId, now),
      )
      if (decided.isLeft()) return left(decided.value)
      await scope.journal.post(transaction.value)
      await scope.manualEntries.save(entry)
      await audit(scope, context, {
        action: 'manual-entry.approved',
        subjectType: 'manual-entry',
        subjectId: entryId,
        occurredAt: now,
        details: { transactionId, requestedBy: entry.requestedBy, ...onBehalfOf(decided.value) },
      })
      await audit(scope, context, {
        action: 'transaction.posted',
        subjectType: 'transaction',
        subjectId: transactionId,
        occurredAt: now,
        details: {
          reference: entry.terms.reference,
          postedOn: entry.terms.postedOn,
          period: transaction.value.period,
          total: transaction.value.total.amount,
          lineCount: entry.terms.lines.length,
          manualEntryId: entryId,
        },
      })
      return right({ status: entry.status, transactionId })
    })
  }

  reject(
    context: CommandContext,
    entryId: string,
    reason: string,
  ): Promise<Either<Failure, { status: string; transactionId: string | null }>> {
    const parsed = Reason.create(reason)
    if (parsed.isLeft()) return Promise.resolve(left(parsed.value))
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const entry = await scope.manualEntries.findForUpdate(entryId)
      if (!entry) return left(new ResourceNotFoundError('manual entry was not found'))
      const now = this.clock.now()
      const authorities = await resolveAuthorities(scope, context, APPROVE_ENTRY, now)
      if (authorities.isLeft()) return left(authorities.value)
      const decided = decideWith(authorities.value, (authority) =>
        entry.reject(authority, parsed.value, now),
      )
      if (decided.isLeft()) return left(decided.value)
      await scope.manualEntries.save(entry)
      await audit(scope, context, {
        action: 'manual-entry.rejected',
        subjectType: 'manual-entry',
        subjectId: entryId,
        occurredAt: now,
        details: { reason: parsed.value.value, ...onBehalfOf(decided.value) },
      })
      return right({ status: entry.status, transactionId: null })
    })
  }
}
