import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { unitsOf } from '@/domain/entities/serial-book'
import type { StockBalance } from '@/domain/entities/stock-balance'
import { StockCount, type Variance } from '@/domain/entities/stock-count'
import { naming } from '@/domain/entities/tracked-units'
import { Money, Note, Quantity } from '@/domain/value-objects/inventory-values'
import type { MovementOrigin } from '@/domain/value-objects/movement-origin'
import { LotCode, SerialNumber } from '@/domain/value-objects/tracking'
import type { Clock } from '../ports/clock'
import type { InventoryScope, InventoryUnitOfWork } from '../ports/unit-of-work'
import { approvalRequired } from './adjust-stock'
import {
  audit,
  type CommandContext,
  type Failure,
  type IdempotentContext,
  type Outcome,
  once,
} from './commands'
import { noteOf, quantityOf, worthOf } from './inputs'
import { openBalance } from './manage-inventory'

export class OpenStockCountUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    warehouseId: string
    itemIds?: readonly string[] | null | undefined
    note?: string | null | undefined
  }): Outcome<{ countId: string; lines: number }> {
    const { context } = request
    const note = noteOf(request.note)
    if (note.isLeft()) return Promise.resolve(left(note.value))

    return once(this.unitOfWork, context, 'open-stock-count', request, async (scope) => {
      const warehouse = await scope.warehouses.findById(request.warehouseId)
      if (!warehouse) return left(new ResourceNotFoundError('warehouse was not found'))
      const itemIds = request.itemIds && request.itemIds.length > 0 ? request.itemIds : null
      const balances = await scope.balances.inWarehouse(request.warehouseId, itemIds)
      const held = new Map(balances.map((balance) => [balance.itemId(), balance]))
      // An item named explicitly but never held is still worth counting: finding
      // something on a shelf the system says is empty is the whole point of a count.
      const lines = (itemIds ?? [...held.keys()]).flatMap((itemId) =>
        sheetFor(itemId, held.get(itemId)),
      )

      const count = StockCount.open({
        tenantId: context.tenantId,
        warehouseId: request.warehouseId,
        lines,
        note: note.value,
        openedBy: context.actor,
        now: this.clock.now(),
      })
      if (count.isLeft()) return left(count.value)

      await scope.counts.create(count.value)
      await audit(scope, context, {
        action: 'count.opened',
        subjectType: 'count',
        subjectId: count.value.id.toString(),
        occurredAt: this.clock.now(),
        details: {
          warehouseId: request.warehouseId,
          lines: count.value.lines().map((line) => ({
            itemId: line.itemId,
            lot: line.lot?.value ?? null,
            serial: line.serial?.value ?? null,
            expected: line.expected.toString(),
          })),
        },
      })
      return right({ countId: count.value.id.toString(), lines: lines.length })
    })
  }
}

export class RecordStockCountUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    countId: string
    counts: readonly {
      itemId: string
      lot?: string | null | undefined
      serial?: string | null | undefined
      counted: string
    }[]
  }): Outcome<void> {
    const { context } = request
    const counts: CountedLine[] = []
    for (const [index, entry] of request.counts.entries()) {
      const parsed = countedOf(entry, index)
      if (parsed.isLeft()) return Promise.resolve(left(parsed.value))
      counts.push(parsed.value)
    }

    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const count = await scope.counts.findById(request.countId)
      if (!count) return left(new ResourceNotFoundError('count was not found'))
      const now = this.clock.now()
      const recorded = count.record(counts, now)
      if (recorded.isLeft()) return left(recorded.value)
      await scope.counts.save(count)
      await audit(scope, context, {
        action: 'count.recorded',
        subjectType: 'count',
        subjectId: request.countId,
        occurredAt: now,
        details: {
          counts: counts.map((entry) => ({
            itemId: entry.itemId,
            counted: entry.counted.toString(),
          })),
        },
      })
      return right(undefined)
    })
  }
}

/**
 * The counting is over and the differences become movements.
 *
 * What the count moves is weighed against the same allowance an adjustment answers to,
 * because a sheet that writes off a warehouse is a write-off whatever it is called. The
 * weight is the sum of the differences in both directions, not their net: a count that
 * finds a hundred of one thing and loses a hundred of another has moved two hundred
 * units of stock, and netting them to nothing would wave it through.
 */
export class CloseStockCountUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    countId: string
  }): Outcome<{ status: string; approvalState: string; variances: number }> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const count = await scope.counts.findById(request.countId)
      if (!count) return left(new ResourceNotFoundError('count was not found'))
      const now = this.clock.now()

      const weight = await weigh(scope, count, count.variances())
      if (weight.isLeft()) return left(weight.value)
      const closed = count.close(context.actor, now, {
        approvalRequired: await approvalRequired(scope, weight.value),
      })
      if (closed.isLeft()) return left(closed.value)

      const posted = await post(scope, count, now)
      if (posted.isLeft()) return left(posted.value)
      await scope.counts.save(count)

      await audit(scope, context, {
        action: 'count.closed',
        subjectType: 'count',
        subjectId: count.id.toString(),
        occurredAt: now,
        details: {
          status: count.status(),
          approvalState: count.approvalState(),
          value: weight.value
            ? { amount: weight.value.amount.toString(), currency: weight.value.currency.value }
            : null,
          variances: count.variances().map(described),
        },
      })
      return right({
        status: count.status(),
        approvalState: count.approvalState(),
        variances: count.variances().length,
      })
    })
  }
}

export type CountDecision =
  | { readonly kind: 'approve' }
  | { readonly kind: 'reject'; readonly reason: string }
  | { readonly kind: 'cancel'; readonly reason: string }

export class DecideStockCountUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    countId: string
    decision: CountDecision
  }): Outcome<{ status: string; approvalState: string }> {
    const { context, decision } = request
    let reason: Note | null = null
    if (decision.kind !== 'approve') {
      const parsed = Note.create(decision.reason, '/reason')
      if (parsed.isLeft()) return Promise.resolve(left(parsed.value))
      reason = parsed.value
    }

    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const count = await scope.counts.findById(request.countId)
      if (!count) return left(new ResourceNotFoundError('count was not found'))
      const now = this.clock.now()
      const decided = decide(count, decision, reason, context.actor, now)
      if (decided.isLeft()) return left(decided.value)

      const posted = await post(scope, count, now)
      if (posted.isLeft()) return left(posted.value)
      await scope.counts.save(count)

      await audit(scope, context, {
        action: `count.${settled[decision.kind]}`,
        subjectType: 'count',
        subjectId: count.id.toString(),
        occurredAt: now,
        details: {
          closedBy: count.closedBy(),
          status: count.status(),
          ...(reason ? { reason: reason.value } : {}),
        },
      })
      return right({ status: count.status(), approvalState: count.approvalState() })
    })
  }
}

function decide(
  count: StockCount,
  decision: CountDecision,
  reason: Note | null,
  actor: string,
  now: Date,
): Either<Failure, void> {
  if (decision.kind === 'approve') return count.approve(actor, now)
  if (!reason) return left(new ConflictError('this decision needs a reason'))
  return decision.kind === 'reject' ? count.reject(actor, reason, now) : count.cancel(reason, now)
}

/** What the differences are worth, at the cost the goods carry right now. */
async function weigh(
  scope: InventoryScope,
  count: StockCount,
  variances: readonly Variance[],
): Promise<Either<Failure, Money | null>> {
  let total: Money | null = null
  for (const variance of variances) {
    const balance = await scope.balances.lock(variance.itemId, count.warehouseId())
    const unitCost = balance?.unitCost()
    if (!unitCost) continue
    const value = worthOf(variance.quantity, unitCost)
    if (!total) {
      total = value
      continue
    }
    if (!total.currency.equals(value.currency))
      return left(
        new ConflictError('a count whose goods are valued in two currencies cannot be weighed'),
      )
    total = Money.fromAmount(total.amount + value.amount, total.currency)
  }
  return right(total)
}

/** Writes the differences, if the count has reached the point of being settled. */
async function post(
  scope: InventoryScope,
  count: StockCount,
  now: Date,
): Promise<Either<Failure, void>> {
  if (!count.posts()) return right(undefined)
  const origin: MovementOrigin = {
    reason: 'count',
    document: { type: 'count', id: count.id.toString() },
  }
  for (const variance of count.variances()) {
    const existing = await scope.balances.lock(variance.itemId, count.warehouseId())
    const balance =
      existing ??
      (await openBalance(scope, { itemId: variance.itemId, warehouseId: count.warehouseId() }, now))
    // The difference is applied to whatever the balance has become, never the figure
    // counted: a delivery that went out during the count is not undone by it. Under lot
    // tracking it goes into or out of the very lot the line was about, which is the whole
    // reason the sheet is walked lot by lot rather than item by item.
    const { named, picked } = naming({
      lot: variance.lot,
      serials: variance.serial ? [variance.serial] : [],
      quantity: variance.quantity,
    })
    const applied =
      variance.direction === 'in'
        ? balance.adjustIn(variance.quantity, null, origin, now, named)
        : balance.adjustOut(variance.quantity, origin, now, picked)
    if (applied.isLeft()) return left(applied.value)
    if (existing) await scope.balances.save(balance)
    else await scope.balances.create(balance)
    for (const event of balance.pullDomainEvents()) await scope.events.append(event)
  }
  return right(undefined)
}

const settled = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' } as const

const described = (variance: Variance) => ({
  itemId: variance.itemId,
  lot: variance.lot?.value ?? null,
  serial: variance.serial?.value ?? null,
  direction: variance.direction,
  quantity: variance.quantity.toString(),
})

interface CountedLine {
  readonly itemId: string
  readonly lot: LotCode | null
  readonly serial: SerialNumber | null
  readonly counted: Quantity
}

/** One figure the counter wrote down, and which line of the sheet it belongs to. */
function countedOf(
  entry: {
    itemId: string
    lot?: string | null | undefined
    serial?: string | null | undefined
    counted: string
  },
  index: number,
): Either<Failure, CountedLine> {
  const counted = quantityOf(entry.counted, `/counts/${index}/counted`)
  if (counted.isLeft()) return left(counted.value)
  let lot: LotCode | null = null
  if (entry.lot) {
    const code = LotCode.create(entry.lot, `/counts/${index}/lot`)
    if (code.isLeft()) return left(code.value)
    lot = code.value
  }
  let serial: SerialNumber | null = null
  if (entry.serial) {
    const named = SerialNumber.create(entry.serial, `/counts/${index}/serial`)
    if (named.isLeft()) return left(named.value)
    serial = named.value
  }
  return right({ itemId: entry.itemId, lot, serial, counted: counted.value })
}

/**
 * The lines a sheet freezes for one item.
 *
 * An item the workspace identifies gets a line per lot on the shelf, because the useful
 * answer is not that there are two fewer but that lot AB-1204 is two short — and because
 * the difference cannot be posted at all without saying which lot it came out of. An item
 * never held, or one nobody identifies, gets the single line it has always had.
 */
function sheetFor(
  itemId: string,
  balance: StockBalance | undefined,
): { itemId: string; lot: LotCode | null; serial: SerialNumber | null; expected: Quantity }[] {
  const single = (expected: Quantity) => [{ itemId, lot: null, serial: null, expected }]
  if (!balance) return single(Quantity.fromMicros(0n))
  if (balance.tracksLots())
    return balance
      .lots()
      .map((lot) => ({ itemId, lot: lot.code, serial: null, expected: lot.onHand }))
  // One line per machine, each expecting the one of it there is. Counting zero of a line
  // is how a counter says the machine is not where the system thinks it is.
  if (balance.tracksSerials())
    return balance
      .serials()
      .map((held) => ({ itemId, lot: null, serial: held.serial, expected: unitsOf(1) }))
  return single(balance.onHand())
}
