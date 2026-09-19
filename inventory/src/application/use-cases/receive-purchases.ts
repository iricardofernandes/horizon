import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { StockBalance } from '@/domain/entities/stock-balance'
import { Currency, Money, Quantity } from '@/domain/value-objects/inventory-values'
import type { Clock } from '../ports/clock'
import type { InventoryScope } from '../ports/unit-of-work'

type InventoryError = InvalidInputError | ConflictError | ResourceNotFoundError

export interface PurchasedLine {
  readonly itemId: string
  readonly quantity: string
  readonly unitPrice: { readonly amount: string; readonly currency: string }
}

export interface PurchaseDelivery {
  readonly tenantId: string
  readonly warehouseId: string
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
    let movements = 0
    for (const line of delivery.lines) {
      const parsed = parse(line)
      if (parsed.isLeft()) return left(parsed.value)
      const existing = await scope.balances.lock(line.itemId, delivery.warehouseId)
      const balance =
        existing ??
        StockBalance.open({
          tenantId: delivery.tenantId,
          itemId: line.itemId,
          warehouseId: delivery.warehouseId,
          now: this.clock.now(),
        })
      const received = balance.receive(
        parsed.value.quantity,
        parsed.value.unitCost,
        this.clock.now(),
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
      lines: readonly { itemId: string; quantity: string }[]
    },
  ): Promise<Either<InventoryError, { movements: number }>> {
    let movements = 0
    for (const line of delivery.lines) {
      const quantity = Quantity.create(line.quantity)
      if (quantity.isLeft()) return left(quantity.value)
      const balance = await scope.balances.lock(line.itemId, delivery.warehouseId)
      if (!balance)
        return left(new ResourceNotFoundError('these goods are not in stock to be returned'))
      const returned = balance.giveBack(quantity.value, this.clock.now())
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
): Either<InventoryError, { quantity: Quantity; unitCost: Money }> {
  const quantity = Quantity.create(line.quantity)
  if (quantity.isLeft()) return left(quantity.value)
  const currency = Currency.create(line.unitPrice.currency)
  if (currency.isLeft()) return left(currency.value)
  const unitCost = Money.create(line.unitPrice.amount, currency.value)
  if (unitCost.isLeft()) return left(unitCost.value)
  return right({ quantity: quantity.value, unitCost: unitCost.value })
}
