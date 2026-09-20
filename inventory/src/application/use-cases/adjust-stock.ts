import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { type AdjustmentDirection, StockAdjustment } from '@/domain/entities/stock-adjustment'
import { StockBalance } from '@/domain/entities/stock-balance'
import { type Money, Note, type Quantity } from '@/domain/value-objects/inventory-values'
import {
  type AdjustmentReason,
  isAdjustmentReason,
  type MovementOrigin,
} from '@/domain/value-objects/movement-origin'
import type { Clock } from '../ports/clock'
import type { InventoryScope, InventoryUnitOfWork } from '../ports/unit-of-work'
import {
  audit,
  type CommandContext,
  type Failure,
  type IdempotentContext,
  type Outcome,
  once,
} from './commands'
import { moneyOf, noteOf, quantityOf, worthOf } from './inputs'

export interface AdjustStockRequest {
  readonly context: IdempotentContext
  readonly warehouseId: string
  readonly itemId: string
  readonly direction: AdjustmentDirection
  readonly quantity: string
  readonly reason: string
  readonly note?: string | null | undefined
  readonly unitCost?: { amount: string; currency: string } | null | undefined
}

/**
 * At or above the workspace's allowance, an adjustment waits for somebody else.
 *
 * A workspace with no allowance set has every adjustment approved, because silence about
 * a control is not permission to skip it. An adjustment worth nothing — goods that have
 * never had a cost — passes: there is no value for a second person to protect.
 */
export async function approvalRequired(
  scope: InventoryScope,
  value: Money | null,
): Promise<boolean> {
  if (!value || value.amount === 0n) return false
  const policy = await scope.policies.find(value.currency.value)
  return policy === null || value.amount >= policy.threshold
}

export class AdjustStockUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(
    request: AdjustStockRequest,
  ): Outcome<{ adjustmentId: string; status: string; approvalState: string }> {
    const { context } = request
    const quantity = quantityOf(request.quantity)
    if (quantity.isLeft()) return Promise.resolve(left(quantity.value))
    const note = noteOf(request.note)
    if (note.isLeft()) return Promise.resolve(left(note.value))
    if (!isAdjustmentReason(request.reason))
      return Promise.resolve(left(new ConflictError('that is not a reason stock is adjusted for')))
    const reason: AdjustmentReason = request.reason
    let stated: Money | null = null
    if (request.unitCost) {
      const parsed = moneyOf(request.unitCost.amount, request.unitCost.currency)
      if (parsed.isLeft()) return Promise.resolve(left(parsed.value))
      stated = parsed.value
    }

    return once(this.unitOfWork, context, 'adjust-stock', request, async (scope) => {
      const warehouse = await scope.warehouses.findById(request.warehouseId)
      if (!warehouse) return left(new ResourceNotFoundError('warehouse was not found'))
      if (!warehouse.isActive()) return left(new ConflictError('warehouse is inactive'))

      const now = this.clock.now()
      const weighed = await weigh(scope, { ...request, quantity: quantity.value, stated }, now)
      if (weighed.isLeft()) return left(weighed.value)
      const { held, value } = weighed.value

      const adjustment = StockAdjustment.request({
        tenantId: context.tenantId,
        warehouseId: request.warehouseId,
        itemId: request.itemId,
        direction: request.direction,
        quantity: quantity.value,
        reason,
        note: note.value,
        statedUnitCost: stated,
        value,
        approvalRequired: await approvalRequired(scope, value),
        requestedBy: context.actor,
        now,
      })
      if (adjustment.isLeft()) return left(adjustment.value)

      if (adjustment.value.posts()) {
        const applied = await write(scope, adjustment.value, held, now)
        if (applied.isLeft()) return left(applied.value)
      }

      await scope.adjustments.create(adjustment.value)
      const made = adjustment.value
      await audit(scope, context, {
        action: 'adjustment.requested',
        subjectType: 'adjustment',
        subjectId: made.id.toString(),
        occurredAt: now,
        details: {
          warehouseId: made.warehouseId(),
          itemId: made.itemId(),
          direction: made.direction(),
          quantity: made.quantity().toString(),
          reason: made.reason(),
          value: described(made.value()),
          approvalState: made.approvalState(),
        },
      })
      return right({
        adjustmentId: made.id.toString(),
        status: made.status(),
        approvalState: made.approvalState(),
      })
    })
  }
}

export type AdjustmentDecision =
  | { readonly kind: 'approve' }
  | { readonly kind: 'reject'; readonly reason: string }

/**
 * Somebody other than the person who asked allows the write-off, or refuses it.
 *
 * Nothing was held while it waited, so an approval can still fail: goods promised to a
 * customer in the meantime are not available to write off, and refusing here is the point
 * rather than an inconvenience.
 */
export class DecideAdjustmentUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    adjustmentId: string
    decision: AdjustmentDecision
  }): Outcome<{ status: string; approvalState: string }> {
    const { context, decision } = request
    let rejection: Note | null = null
    if (decision.kind === 'reject') {
      const parsed = Note.create(decision.reason, '/reason')
      if (parsed.isLeft()) return Promise.resolve(left(parsed.value))
      rejection = parsed.value
    }

    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const adjustment = await scope.adjustments.findById(request.adjustmentId)
      if (!adjustment) return left(new ResourceNotFoundError('adjustment was not found'))
      const now = this.clock.now()
      const decided = rejection
        ? adjustment.reject(context.actor, rejection, now)
        : adjustment.approve(context.actor, now)
      if (decided.isLeft()) return left(decided.value)

      if (adjustment.posts()) {
        const held = await hold(scope, adjustment.itemId(), adjustment.warehouseId(), now)
        const applied = await write(scope, adjustment, held, now)
        if (applied.isLeft()) return left(applied.value)
      }

      await scope.adjustments.save(adjustment)
      await audit(scope, context, {
        action: decision.kind === 'approve' ? 'adjustment.approved' : 'adjustment.rejected',
        subjectType: 'adjustment',
        subjectId: adjustment.id.toString(),
        occurredAt: now,
        details: {
          requestedBy: adjustment.requestedBy(),
          quantity: adjustment.quantity().toString(),
          direction: adjustment.direction(),
          value: described(adjustment.value()),
          ...(decision.kind === 'reject' ? { reason: decision.reason } : {}),
        },
      })
      return right({ status: adjustment.status(), approvalState: adjustment.approvalState() })
    })
  }
}

interface Held {
  readonly balance: StockBalance
  readonly existing: boolean
}

const described = (value: Money | null) =>
  value ? { amount: value.amount.toString(), currency: value.currency.value } : null

/**
 * The balance this adjustment moves, and what the movement is worth.
 *
 * Judged before anything is written, on the cost the goods carry now rather than the one
 * they will carry when an approval is granted. A count may bring in goods nobody can
 * price; a deliberate entry may not, because somebody typing stock into existence has to
 * say what it is worth or the allowance protects nothing.
 */
async function weigh(
  scope: InventoryScope,
  request: {
    itemId: string
    warehouseId: string
    direction: AdjustmentDirection
    quantity: Quantity
    stated: Money | null
  },
  now: Date,
): Promise<Either<Failure, { held: Held; value: Money | null }>> {
  const held = await hold(scope, request.itemId, request.warehouseId, now)
  if (!held.existing && request.direction === 'out')
    return left(new ResourceNotFoundError('this warehouse holds none of this item'))
  const unitCost = held.balance.unitCost() ?? request.stated
  if (!unitCost && request.direction === 'in')
    return left(new ConflictError('these goods have never had a cost: state one to bring them in'))
  return right({ held, value: unitCost ? worthOf(request.quantity, unitCost) : null })
}

/** This item's balance in this warehouse, locked, opening an empty one if there is none. */
async function hold(
  scope: InventoryScope,
  itemId: string,
  warehouseId: string,
  now: Date,
): Promise<Held> {
  const balance = await scope.balances.lock(itemId, warehouseId)
  if (balance) return { balance, existing: true }
  return {
    balance: StockBalance.open({ tenantId: scope.tenantId, itemId, warehouseId, now }),
    existing: false,
  }
}

/** Moves the goods and writes both the balance and the movement that explains it. */
async function write(
  scope: InventoryScope,
  adjustment: StockAdjustment,
  held: Held,
  now: Date,
): Promise<Either<Failure, void>> {
  const origin: MovementOrigin = {
    reason: adjustment.reason(),
    document: { type: 'adjustment', id: adjustment.id.toString() },
  }
  const applied =
    adjustment.direction() === 'in'
      ? held.balance.adjustIn(adjustment.quantity(), adjustment.statedUnitCost(), origin, now)
      : held.balance.adjustOut(adjustment.quantity(), origin, now)
  if (applied.isLeft()) return left(applied.value)
  if (held.existing) await scope.balances.save(held.balance)
  else await scope.balances.create(held.balance)
  for (const event of held.balance.pullDomainEvents()) await scope.events.append(event)
  return right(undefined)
}
