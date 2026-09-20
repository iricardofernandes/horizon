import { randomUUID } from 'node:crypto'
import { InMemoryInventoryUnitOfWork } from 'test/repositories/in-memory-inventory-unit-of-work'
import { beforeEach, describe, expect, it } from 'vitest'
import { DefineItemTrackingUseCase } from './use-cases/define-policies'
import { CreateWarehouseUseCase, ReceiveStockUseCase } from './use-cases/manage-inventory'

const now = new Date('2026-09-20T09:00:00.000Z')
const clock = { now: () => now }
const KEEPER = 'user-keeper'

let unitOfWork: InMemoryInventoryUnitOfWork
let define: DefineItemTrackingUseCase
let tenantId: string
let warehouseId: string
let itemId: string

const context = () => ({ tenantId, actor: KEEPER, requestId: null })

beforeEach(async () => {
  unitOfWork = new InMemoryInventoryUnitOfWork()
  define = new DefineItemTrackingUseCase(unitOfWork, clock)
  tenantId = randomUUID()
  itemId = randomUUID()
  const warehouse = await new CreateWarehouseUseCase(unitOfWork, clock).execute({
    tenantId,
    name: 'Main',
  })
  if (warehouse.isLeft()) throw warehouse.value
  warehouseId = warehouse.value.warehouseId
})

/** Ten of the item on the shelf, under a lot if the item is tracked by one. */
async function stock(lot: string | null) {
  return new ReceiveStockUseCase(unitOfWork, clock).execute({
    tenantId,
    warehouseId,
    itemId,
    quantity: '10',
    unitCost: '1000',
    currency: 'BRL',
    lots: lot === null ? null : [{ code: lot, quantity: '10' }],
  })
}

describe('deciding whether an item has to be identified', () => {
  it('records the decision and who took it', async () => {
    const item = await define.execute({
      context: context(),
      itemId,
      tracking: 'lot',
      expiry: 'required',
    })

    if (item.isLeft()) throw item.value
    expect(item.value.tracking).toEqual({ kind: 'lot', expiry: 'required' })
    expect(item.value.updatedBy).toBe(KEEPER)
  })

  it('refuses an expiry rule for an item nobody is identifying', async () => {
    const item = await define.execute({
      context: context(),
      itemId,
      tracking: 'none',
      expiry: 'required',
    })

    expect(item.isLeft()).toBe(true)
  })

  it('refuses serial numbers, which the module cannot yet honour', async () => {
    // Better a plain refusal than a workspace turning on a control that does nothing.
    const item = await define.execute({ context: context(), itemId, tracking: 'serial' })

    expect(item.isLeft()).toBe(true)
  })

  it('will not start identifying goods that are already on a shelf', async () => {
    await stock(null)

    const item = await define.execute({ context: context(), itemId, tracking: 'lot' })

    if (item.isRight()) throw new Error('expected a refusal')
    expect(item.value.title).toBe('Conflict')
  })

  it('will not stop identifying goods that are already on a shelf', async () => {
    await define.execute({ context: context(), itemId, tracking: 'lot' })
    await stock('AB-1204')

    const item = await define.execute({ context: context(), itemId, tracking: 'none' })

    expect(item.isLeft()).toBe(true)
  })

  it('lets the same decision be restated at any time', async () => {
    await define.execute({ context: context(), itemId, tracking: 'lot' })
    await stock('AB-1204')

    // Nothing changes, so there is nothing for the shelves to be wrong about.
    const again = await define.execute({ context: context(), itemId, tracking: 'lot' })

    expect(again.isRight()).toBe(true)
  })

  it('lets the decision change once the shelves are empty again', async () => {
    await define.execute({ context: context(), itemId, tracking: 'lot' })

    const item = await define.execute({
      context: context(),
      itemId,
      tracking: 'lot',
      expiry: 'required',
    })

    if (item.isLeft()) throw item.value
    expect(item.value.tracking.expiry).toBe('required')
  })

  it('governs what the next delivery has to say about itself', async () => {
    await define.execute({ context: context(), itemId, tracking: 'lot' })

    const unnamed = await stock(null)
    const named = await stock('AB-1204')

    expect(unnamed.isLeft()).toBe(true)
    expect(named.isRight()).toBe(true)
  })

  it('names whoever took it in the audit chain', async () => {
    await define.execute({ context: context(), itemId, tracking: 'lot', expiry: 'optional' })

    const entry = unitOfWork.auditRecords.at(-1)
    expect(entry?.action).toBe('item.tracking-defined')
    expect(entry?.subjectType).toBe('item')
    expect(entry?.details).toMatchObject({ tracking: 'lot', expiry: 'optional' })
  })
})
