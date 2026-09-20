import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { LotPick } from '@/domain/entities/lot-book'
import type { StockBalance } from '@/domain/entities/stock-balance'
import { StockTransfer, type TransferLine } from '@/domain/entities/stock-transfer'
import type { MovementOrigin } from '@/domain/value-objects/movement-origin'
import type { Clock } from '../ports/clock'
import type { InventoryScope, InventoryUnitOfWork } from '../ports/unit-of-work'
import { audit, type Failure, type IdempotentContext, type Outcome, once } from './commands'
import { lotPicksOf, noteOf, quantityOf } from './inputs'
import { openBalance } from './manage-inventory'

export interface TransferStockRequest {
  readonly context: IdempotentContext
  readonly sourceWarehouseId: string
  readonly destinationWarehouseId: string
  readonly lines: readonly {
    itemId: string
    quantity: string
    /** Which boxes to send. Left out, the source sends whatever should go first. */
    lots?: readonly { code: string; quantity: string }[] | null | undefined
  }[]
  readonly note?: string | null | undefined
}

/**
 * Goods move between two of the company's own warehouses.
 *
 * Both halves are written in one transaction, so there is no moment at which the stock is
 * in neither place. What leaves the source carries its cost to the destination rather
 * than being valued again there: the company owns exactly what it owned a second ago, and
 * the only thing that changed is which shelf it is on.
 */
export class TransferStockUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: TransferStockRequest): Outcome<{ transferId: string }> {
    const { context } = request
    const note = noteOf(request.note)
    if (note.isLeft()) return Promise.resolve(left(note.value))
    const lines: TransferLine[] = []
    const picked = new Map<string, readonly LotPick[] | null>()
    for (const [index, line] of request.lines.entries()) {
      const quantity = quantityOf(line.quantity, `/lines/${index}/quantity`)
      if (quantity.isLeft()) return Promise.resolve(left(quantity.value))
      const picks = lotPicksOf(line.lots, `/lines/${index}/lots`)
      if (picks.isLeft()) return Promise.resolve(left(picks.value))
      picked.set(line.itemId, picks.value)
      lines.push({ itemId: line.itemId, quantity: quantity.value })
    }

    return once(this.unitOfWork, context, 'transfer-stock', request, async (scope) => {
      const source = await scope.warehouses.findById(request.sourceWarehouseId)
      if (!source) return left(new ResourceNotFoundError('the source warehouse was not found'))
      const destination = await scope.warehouses.findById(request.destinationWarehouseId)
      if (!destination)
        return left(new ResourceNotFoundError('the destination warehouse was not found'))
      // Goods may leave a warehouse that has been closed — that is how one is emptied —
      // but nothing is put into one that has been.
      if (!destination.isActive())
        return left(new ConflictError('the destination warehouse is inactive'))

      const transfer = StockTransfer.post({
        tenantId: context.tenantId,
        sourceWarehouseId: request.sourceWarehouseId,
        destinationWarehouseId: request.destinationWarehouseId,
        lines,
        note: note.value,
        movedBy: context.actor,
        now: this.clock.now(),
      })
      if (transfer.isLeft()) return left(transfer.value)

      const origin: MovementOrigin = {
        reason: 'transfer',
        document: { type: 'transfer', id: transfer.value.id.toString() },
      }
      const moved = await this.move(scope, transfer.value, origin, picked)
      if (moved.isLeft()) return left(moved.value)

      const now = this.clock.now()
      await scope.transfers.create(transfer.value)
      await audit(scope, context, {
        action: 'transfer.posted',
        subjectType: 'transfer',
        subjectId: transfer.value.id.toString(),
        occurredAt: now,
        details: {
          sourceWarehouseId: transfer.value.source(),
          destinationWarehouseId: transfer.value.destination(),
          lines: described(transfer.value.lines()),
        },
      })
      return right({ transferId: transfer.value.id.toString() })
    })
  }

  private async move(
    scope: InventoryScope,
    transfer: StockTransfer,
    origin: MovementOrigin,
    picked: ReadonlyMap<string, readonly LotPick[] | null>,
  ): Promise<Either<Failure, void>> {
    const now = this.clock.now()
    const held = await lockAll(scope, transfer, now)
    if (held.isLeft()) return left(held.value)

    for (const line of transfer.lines()) {
      const from = held.value.get(key(line.itemId, transfer.source()))
      const to = held.value.get(key(line.itemId, transfer.destination()))
      if (!from || !to) return left(new ConflictError('a transferred balance went missing'))
      const moved = carry(from.balance, to.balance, line, origin, now, picked.get(line.itemId))
      if (moved.isLeft()) return left(moved.value)
    }

    for (const { balance, existing } of held.value.values()) {
      if (existing) await scope.balances.save(balance)
      else await scope.balances.create(balance)
      for (const event of balance.pullDomainEvents()) await scope.events.append(event)
    }
    return right(undefined)
  }
}

interface Held {
  readonly balance: StockBalance
  readonly existing: boolean
}

/**
 * One line's worth of goods off one shelf and onto another.
 *
 * The very boxes that left arrive, with the dates they left carrying: a transfer moves
 * where goods are, never which goods they are, so the destination is handed exactly what
 * the source drew rather than being asked to choose again.
 */
function carry(
  from: StockBalance,
  to: StockBalance,
  line: TransferLine,
  origin: MovementOrigin,
  now: Date,
  picks: readonly LotPick[] | null | undefined,
): Either<Failure, void> {
  const taken = from.transferOut(line.quantity, origin, now, picks ?? null)
  if (taken.isLeft()) return left(taken.value)
  const drawn = taken.value.drawn
  return to.transferIn(
    line.quantity,
    taken.value.cost,
    origin,
    now,
    drawn.length > 0 ? drawn : null,
  )
}

const key = (itemId: string, warehouseId: string) => `${itemId}:${warehouseId}`

const described = (lines: readonly TransferLine[]) =>
  lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity.toString() }))

/**
 * Every balance the transfer touches, locked in one order.
 *
 * Two transfers running in opposite directions between the same two warehouses would
 * deadlock if each locked its own source first, so the pairs are sorted and taken in that
 * order by everybody. A destination that has never held the item gets an empty balance;
 * a source that has not is an error, because there is nothing there to move.
 */
async function lockAll(
  scope: InventoryScope,
  transfer: StockTransfer,
  now: Date,
): Promise<Either<Failure, Map<string, Held>>> {
  const held = new Map<string, Held>()
  const wanted = transfer
    .lines()
    .flatMap((line) => [
      { itemId: line.itemId, warehouseId: transfer.source() },
      { itemId: line.itemId, warehouseId: transfer.destination() },
    ])
    .sort((a, b) => key(a.itemId, a.warehouseId).localeCompare(key(b.itemId, b.warehouseId)))

  for (const { itemId, warehouseId } of wanted) {
    if (held.has(key(itemId, warehouseId))) continue
    const balance = await scope.balances.lock(itemId, warehouseId)
    if (!balance && warehouseId === transfer.source())
      return left(new ResourceNotFoundError('the source warehouse holds none of this item'))
    held.set(key(itemId, warehouseId), {
      balance: balance ?? (await openBalance(scope, { itemId, warehouseId }, now)),
      existing: balance !== null,
    })
  }
  return right(held)
}
