import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { StockBalance } from '@/domain/entities/stock-balance'
import { Warehouse } from '@/domain/entities/warehouse'
import { Currency, Money, Quantity, WarehouseName } from '@/domain/value-objects/inventory-values'
import type { Clock } from '../ports/clock'
import type { InventoryUnitOfWork } from '../ports/unit-of-work'

type InventoryError = InvalidInputError | ConflictError | ResourceNotFoundError

export class CreateWarehouseUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    tenantId: string
    name: string
  }): Promise<Either<InvalidInputError | ConflictError, { warehouseId: string }>> {
    const name = WarehouseName.create(request.name)
    if (name.isLeft()) return left(name.value)
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      if (await scope.warehouses.findByName(name.value.value))
        return left(new ConflictError('warehouse name already exists'))
      const warehouse = Warehouse.create({
        tenantId: request.tenantId,
        name: name.value,
        now: this.clock.now(),
      })
      await scope.warehouses.create(warehouse)
      return right({ warehouseId: warehouse.id.toString() })
    })
  }
}

export class DeactivateWarehouseUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    tenantId: string
    warehouseId: string
  }): Promise<Either<InventoryError, void>> {
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const warehouse = await scope.warehouses.findById(request.warehouseId)
      if (!warehouse) return left(new ResourceNotFoundError('warehouse was not found'))
      const result = warehouse.deactivate(this.clock.now())
      if (result.isLeft()) return left(result.value)
      await scope.warehouses.save(warehouse)
      return right(undefined)
    })
  }
}

export class ReceiveStockUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    tenantId: string
    warehouseId: string
    itemId: string
    quantity: string
    unitCost: string
    currency: string
  }): Promise<Either<InventoryError, { balanceId: string }>> {
    const quantity = Quantity.create(request.quantity)
    if (quantity.isLeft()) return left(quantity.value)
    const currency = Currency.create(request.currency)
    if (currency.isLeft()) return left(currency.value)
    const unitCost = Money.create(request.unitCost, currency.value)
    if (unitCost.isLeft()) return left(unitCost.value)
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const warehouse = await scope.warehouses.findById(request.warehouseId)
      if (!warehouse) return left(new ResourceNotFoundError('warehouse was not found'))
      if (!warehouse.isActive()) return left(new ConflictError('warehouse is inactive'))
      const existing = await scope.balances.lock(request.itemId, request.warehouseId)
      const balance =
        existing ??
        StockBalance.open({
          tenantId: request.tenantId,
          itemId: request.itemId,
          warehouseId: request.warehouseId,
          now: this.clock.now(),
        })
      const received = balance.receive(quantity.value, unitCost.value, this.clock.now())
      if (received.isLeft()) return left(received.value)
      if (existing) await scope.balances.save(balance)
      else await scope.balances.create(balance)
      for (const event of balance.pullDomainEvents()) await scope.events.append(event)
      return right({ balanceId: balance.id.toString() })
    })
  }
}
