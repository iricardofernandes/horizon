import { left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { AccountingPeriod } from '@/domain/entities/accounting-period'
import { Period, Reason } from '@/domain/value-objects/ledger-values'
import type { Clock } from '../ports/clock'
import type { LedgerScope, LedgerUnitOfWork } from '../ports/unit-of-work'
import { audit, type IdempotentContext, type Outcome, once } from './commands'

/**
 * Close a month. Nothing may be posted into it, or reversed inside it, until someone
 * reopens it with a reason — which is the only thing that makes a trial balance for a
 * closed month mean anything.
 */
export class ClosePeriodUseCase {
  constructor(
    private readonly unitOfWork: LedgerUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    period: string
  }): Outcome<{ id: string; period: string }> {
    const period = Period.create(request.period)
    if (period.isLeft()) return left(period.value)
    const { context } = request
    const month = period.value
    return once(
      this.unitOfWork,
      context,
      'period.close',
      { period: month.value },
      async (scope) => {
        await scope.lockPeriod(month.value)
        const now = this.clock.now()
        const existing = await scope.periods.findForUpdate(month.value)
        if (existing) {
          const closed = existing.closeAgain(context.actor, now)
          if (closed.isLeft()) return left(closed.value)
          await scope.periods.save(existing)
          await recordClosure(scope, context, existing.id.toString(), month.value, now)
          return right({ id: existing.id.toString(), period: month.value })
        }
        const closure = AccountingPeriod.close({
          tenantId: context.tenantId,
          period: month,
          actor: context.actor,
          now,
        })
        await scope.periods.create(closure)
        await recordClosure(scope, context, closure.id.toString(), month.value, now)
        return right({ id: closure.id.toString(), period: month.value })
      },
    )
  }
}

export class ReopenPeriodUseCase {
  constructor(
    private readonly unitOfWork: LedgerUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    period: string
    reason: string
  }): Outcome<{ id: string; period: string }> {
    const period = Period.create(request.period)
    if (period.isLeft()) return left(period.value)
    const reason = Reason.create(request.reason)
    if (reason.isLeft()) return left(reason.value)
    const { context } = request
    const month = period.value.value
    const fingerprint = { period: month, reason: request.reason }
    return once(this.unitOfWork, context, 'period.reopen', fingerprint, async (scope) => {
      await scope.lockPeriod(month)
      const closure = await scope.periods.findForUpdate(month)
      if (!closure) return left(new ConflictError(`period ${month} is already open`))
      const now = this.clock.now()
      const reopened = closure.reopen(context.actor, reason.value, now)
      if (reopened.isLeft()) return left(reopened.value)
      await scope.periods.save(closure)
      await audit(scope, context, {
        action: 'period.reopened',
        subjectType: 'period',
        subjectId: closure.id.toString(),
        occurredAt: now,
        details: { period: month, reason: reason.value.value },
      })
      return right({ id: closure.id.toString(), period: month })
    })
  }
}

function recordClosure(
  scope: LedgerScope,
  context: IdempotentContext,
  subjectId: string,
  period: string,
  occurredAt: Date,
) {
  return audit(scope, context, {
    action: 'period.closed',
    subjectType: 'period',
    subjectId,
    occurredAt,
    details: { period },
  })
}
