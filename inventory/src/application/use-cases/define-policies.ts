import { left, right } from '@/core/either'
import type { AdjustmentPolicy } from '@/domain/repositories/inventory-repositories'
import { Money } from '@/domain/value-objects/inventory-values'
import type { Clock } from '../ports/clock'
import type { InventoryUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext, type Outcome } from './commands'
import { currencyOf } from './inputs'

/**
 * The value at or above which an adjustment needs a second person.
 *
 * Setting it to zero means every adjustment is allowed by somebody else; there is no way
 * to remove the allowance, because "no policy" already means "ask someone" and a
 * workspace should not be able to turn the control off by deleting a row.
 */
export class DefineAdjustmentPolicyUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    currency: string
    threshold: string
  }): Outcome<AdjustmentPolicy> {
    const { context } = request
    const currency = currencyOf(request.currency)
    if (currency.isLeft()) return Promise.resolve(left(currency.value))
    const threshold = Money.create(request.threshold, currency.value, '/threshold')
    if (threshold.isLeft()) return Promise.resolve(left(threshold.value))

    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const now = this.clock.now()
      const policy: AdjustmentPolicy = {
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
