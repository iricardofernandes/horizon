import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { ApprovalPolicy } from '@/domain/repositories/procurement-repositories'
import { Money } from '@/domain/value-objects/procurement-values'
import type { Clock } from '../ports/clock'
import type { ProcurementUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext } from './commands'
import { currencyOf } from './inputs'

/**
 * The value at or above which an order needs a second person.
 *
 * Setting it to zero means every order is approved by someone else; removing the currency
 * from the policy is not offered, because "no policy" already means "ask someone" and a
 * workspace should not be able to turn approval off by deleting a row.
 */
export class DefineApprovalPolicyUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    currency: string
    threshold: string
  }): Promise<Either<InvalidInputError, ApprovalPolicy>> {
    const { context } = request
    const currency = currencyOf(request.currency)
    if (currency.isLeft()) return Promise.resolve(left(currency.value))
    const threshold = Money.create(request.threshold, currency.value, '/threshold')
    if (threshold.isLeft()) return Promise.resolve(left(threshold.value))
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const now = this.clock.now()
      const policy: ApprovalPolicy = {
        tenantId: context.tenantId,
        currency: currency.value.value,
        threshold: threshold.value.amount,
        updatedBy: context.actor,
        updatedAt: now,
      }
      await scope.policies.save(policy)
      await audit(scope, context, {
        action: 'policy.defined',
        subjectType: 'policy',
        subjectId: policy.currency,
        occurredAt: now,
        details: { threshold: policy.threshold.toString(), currency: policy.currency },
      })
      return right(policy)
    })
  }
}
