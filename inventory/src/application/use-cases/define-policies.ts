import { left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { AdjustmentPolicy, StockLevel } from '@/domain/repositories/inventory-repositories'
import { Money } from '@/domain/value-objects/inventory-values'
import type { Clock } from '../ports/clock'
import type { InventoryUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext, type Outcome } from './commands'
import { currencyOf, quantityOf } from './inputs'

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

/**
 * How little of an item a warehouse should get down to, and how much is too much.
 *
 * Nothing here refuses anything. A level is read by the alert report and by nobody else,
 * which is why setting one is not an approval decision and why there is no way to remove
 * one: a minimum of zero says "do not tell me about this item" on the record, where the
 * next person can see that somebody decided it.
 *
 * The maximum is optional because plenty of items have no upper bound worth naming, and
 * when there is one it is compared against what is physically there rather than what is
 * free — stock promised to an order still takes up the shelf it is sitting on.
 */
export class DefineStockLevelUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    warehouseId: string
    itemId: string
    minimum: string
    maximum?: string | null
  }): Outcome<StockLevel> {
    const { context } = request
    const minimum = quantityOf(request.minimum, '/minimum')
    if (minimum.isLeft()) return Promise.resolve(left(minimum.value))
    const stated = request.maximum ?? null
    const maximum = stated === null ? null : quantityOf(stated, '/maximum')
    if (maximum?.isLeft()) return Promise.resolve(left(maximum.value))
    const ceiling = maximum?.isRight() ? maximum.value : null
    if (ceiling?.isLessThan(minimum.value))
      return Promise.resolve(left(new ConflictError('the maximum cannot be below the minimum')))

    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const warehouse = await scope.warehouses.findById(request.warehouseId)
      if (!warehouse) return left(new ResourceNotFoundError('warehouse was not found'))
      const now = this.clock.now()
      const level: StockLevel = {
        tenantId: context.tenantId,
        warehouseId: request.warehouseId,
        itemId: request.itemId,
        minimum: minimum.value.micros,
        maximum: ceiling?.micros ?? null,
        updatedBy: context.actor,
        updatedAt: now,
      }
      await scope.levels.save(level)
      await audit(scope, context, {
        action: 'level.defined',
        subjectType: 'level',
        subjectId: `${level.warehouseId}:${level.itemId}`,
        occurredAt: now,
        details: {
          warehouseId: level.warehouseId,
          itemId: level.itemId,
          minimum: minimum.value.toString(),
          maximum: ceiling?.toString() ?? null,
        },
      })
      return right(level)
    })
  }
}
