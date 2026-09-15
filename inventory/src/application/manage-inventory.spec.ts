import { randomUUID } from 'node:crypto'
import { InMemoryInventoryUnitOfWork } from 'test/repositories/in-memory-inventory-unit-of-work'
import { describe, expect, it } from 'vitest'
import {
  CreateWarehouseUseCase,
  DeactivateWarehouseUseCase,
  ReceiveStockUseCase,
} from './use-cases/manage-inventory'

const now = new Date('2026-09-15T12:00:00.000Z')
const clock = { now: () => now }

describe('inventory management', () => {
  it('creates a warehouse, receives stock and deactivates the location', async () => {
    const unitOfWork = new InMemoryInventoryUnitOfWork()
    const tenantId = randomUUID()
    const createWarehouse = new CreateWarehouseUseCase(unitOfWork, clock)
    const receiveStock = new ReceiveStockUseCase(unitOfWork, clock)
    const deactivateWarehouse = new DeactivateWarehouseUseCase(unitOfWork, clock)

    const created = await createWarehouse.execute({ tenantId, name: 'Main warehouse' })
    expect(created.isRight()).toBe(true)
    if (created.isLeft()) throw created.value

    const received = await receiveStock.execute({
      tenantId,
      warehouseId: created.value.warehouseId,
      itemId: randomUUID(),
      quantity: '12.5',
      unitCost: '999',
      currency: 'BRL',
    })
    expect(received.isRight()).toBe(true)
    expect(unitOfWork.balances[0]?.available().toString()).toBe('12.5')
    expect(unitOfWork.events[0]?.payloadOf()).toMatchObject({
      balanceAfter: '12.5',
      unitCost: { amount: '999', currency: 'BRL' },
    })
    expect(unitOfWork.events).toHaveLength(1)

    const deactivated = await deactivateWarehouse.execute({
      tenantId,
      warehouseId: created.value.warehouseId,
    })
    expect(deactivated.isRight()).toBe(true)
    expect(unitOfWork.warehouses[0]?.isActive()).toBe(false)

    const refused = await receiveStock.execute({
      tenantId,
      warehouseId: created.value.warehouseId,
      itemId: randomUUID(),
      quantity: '1',
      unitCost: '100',
      currency: 'BRL',
    })
    expect(refused.isLeft()).toBe(true)
  })

  it('rejects duplicate warehouse names and invalid receipts', async () => {
    const unitOfWork = new InMemoryInventoryUnitOfWork()
    const tenantId = randomUUID()
    const createWarehouse = new CreateWarehouseUseCase(unitOfWork, clock)
    await createWarehouse.execute({ tenantId, name: 'Main' })
    expect((await createWarehouse.execute({ tenantId, name: 'Main' })).isLeft()).toBe(true)

    const receiveStock = new ReceiveStockUseCase(unitOfWork, clock)
    expect(
      (
        await receiveStock.execute({
          tenantId,
          warehouseId: randomUUID(),
          itemId: randomUUID(),
          quantity: 'invalid',
          unitCost: '100',
          currency: 'BRL',
        })
      ).isLeft(),
    ).toBe(true)
  })
})
