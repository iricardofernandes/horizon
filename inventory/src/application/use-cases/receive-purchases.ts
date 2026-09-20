import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { LotEntry } from '@/domain/entities/lot-book'
import { Currency, Money, Quantity } from '@/domain/value-objects/inventory-values'
import type { MovementOrigin } from '@/domain/value-objects/movement-origin'
import type { Clock } from '../ports/clock'
import type { InventoryScope } from '../ports/unit-of-work'
import { lotEntriesOf, lotPicksOf } from './inputs'
import { openBalance } from './manage-inventory'

type InventoryError = InvalidInputError | ConflictError | ResourceNotFoundError

export interface PurchasedLine {
  readonly itemId: string
  readonly quantity: string
  readonly unitPrice: { readonly amount: string; readonly currency: string }
  readonly lots?:
    | readonly { code: string; expiresOn?: string | null | undefined; quantity: string }[]
    | null
    | undefined
}

export interface PurchaseDelivery {
  readonly tenantId: string
  readonly warehouseId: string
  /** The goods receipt these goods arrived on, which is what a recall is traced back to. */
  readonly receiptId?: string | null
  readonly lines: readonly PurchasedLine[]
}

/**
 * Bring a purchase delivery into stock.
 *
 * The cost each line enters at is what the purchase order agreed to pay for it, which is
 * the only cost anybody has committed to; freight and tax are apportioned on the order's
 * payable and are a valuation question this does not answer.
 */
export class ReceivePurchasedGoodsUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: InventoryScope,
    delivery: PurchaseDelivery,
  ): Promise<Either<InventoryError, { movements: number }>> {
    const warehouse = await scope.warehouses.findById(delivery.warehouseId)
    if (!warehouse) return left(new ResourceNotFoundError('warehouse was not found'))
    if (!warehouse.isActive()) return left(new ConflictError('warehouse is inactive'))
    const origin = originOf(delivery.receiptId)
    let movements = 0
    for (const line of delivery.lines) {
      const parsed = parse(line)
      if (parsed.isLeft()) return left(parsed.value)
      const existing = await scope.balances.lock(line.itemId, delivery.warehouseId)
      const balance =
        existing ??
        (await openBalance(
          scope,
          { tenantId: delivery.tenantId, itemId: line.itemId, warehouseId: delivery.warehouseId },
          this.clock.now(),
        ))
      const received = balance.receive(
        parsed.value.quantity,
        parsed.value.unitCost,
        this.clock.now(),
        parsed.value.lots,
        origin,
      )
      if (received.isLeft()) return left(received.value)
      if (existing) await scope.balances.save(balance)
      else await scope.balances.create(balance)
      for (const event of balance.pullDomainEvents()) await scope.events.append(event)
      movements += 1
    }
    return right({ movements })
  }
}

/** A delivery that went back to its supplier leaves stock again. */
export class ReturnPurchasedGoodsUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: InventoryScope,
    delivery: {
      tenantId: string
      warehouseId: string
      receiptId?: string | null
      lines: readonly {
        itemId: string
        quantity: string
        lots?: readonly { code: string; quantity: string }[] | null | undefined
      }[]
    },
  ): Promise<Either<InventoryError, { movements: number }>> {
    const origin = originOf(delivery.receiptId)
    let movements = 0
    for (const line of delivery.lines) {
      const quantity = Quantity.create(line.quantity)
      if (quantity.isLeft()) return left(quantity.value)
      const picks = lotPicksOf(line.lots)
      if (picks.isLeft()) return left(picks.value)
      const balance = await scope.balances.lock(line.itemId, delivery.warehouseId)
      if (!balance)
        return left(new ResourceNotFoundError('these goods are not in stock to be returned'))
      // Nobody said which boxes go back, so the shelf decides as it does for anything
      // else leaving: earliest date first. A supplier owed a particular lot is named one.
      const returned = balance.giveBack(quantity.value, this.clock.now(), picks.value, origin)
      if (returned.isLeft()) return left(returned.value)
      await scope.balances.save(balance)
      for (const event of balance.pullDomainEvents()) await scope.events.append(event)
      movements += 1
    }
    return right({ movements })
  }
}

function parse(
  line: PurchasedLine,
): Either<
  InventoryError,
  { quantity: Quantity; unitCost: Money; lots: readonly LotEntry[] | null }
> {
  const quantity = Quantity.create(line.quantity)
  if (quantity.isLeft()) return left(quantity.value)
  const currency = Currency.create(line.unitPrice.currency)
  if (currency.isLeft()) return left(currency.value)
  const unitCost = Money.create(line.unitPrice.amount, currency.value)
  if (unitCost.isLeft()) return left(unitCost.value)
  const lots = lotEntriesOf(line.lots)
  if (lots.isLeft()) return left(lots.value)
  return right({ quantity: quantity.value, unitCost: unitCost.value, lots: lots.value })
}

/** Goods arrived because they were bought, and the receipt is which delivery brought them. */
const originOf = (receiptId: string | null | undefined): MovementOrigin | undefined =>
  receiptId ? { reason: 'purchase', document: { type: 'receipt', id: receiptId } } : undefined
