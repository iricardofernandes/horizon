import { randomUUID } from 'node:crypto'
import { InMemoryInventoryUnitOfWork } from 'test/repositories/in-memory-inventory-unit-of-work'
import { beforeEach, describe, expect, it } from 'vitest'
import { DefineStockLevelUseCase } from './use-cases/define-policies'
import { CreateWarehouseUseCase } from './use-cases/manage-inventory'

const now = new Date('2026-09-20T09:00:00.000Z')
const clock = { now: () => now }
const PLANNER = 'user-planner'

let unitOfWork: InMemoryInventoryUnitOfWork
let define: DefineStockLevelUseCase
let tenantId: string
let warehouseId: string
let itemId: string

const context = () => ({ tenantId, actor: PLANNER, requestId: null })

beforeEach(async () => {
  unitOfWork = new InMemoryInventoryUnitOfWork()
  define = new DefineStockLevelUseCase(unitOfWork, clock)
  tenantId = randomUUID()
  itemId = randomUUID()
  const warehouse = await new CreateWarehouseUseCase(unitOfWork, clock).execute({
    tenantId,
    name: 'Main',
  })
  if (warehouse.isLeft()) throw warehouse.value
  warehouseId = warehouse.value.warehouseId
})

describe('the level a warehouse should keep an item at', () => {
  it('records a minimum, an optional maximum and who set them', async () => {
    const level = await define.execute({
      context: context(),
      warehouseId,
      itemId,
      minimum: '20',
      maximum: '100',
    })

    if (level.isLeft()) throw level.value
    expect(level.value.minimum).toBe(20_000_000n)
    expect(level.value.maximum).toBe(100_000_000n)
    expect(level.value.updatedBy).toBe(PLANNER)
    expect(unitOfWork.levels).toHaveLength(1)
  })

  it('leaves the ceiling open when none is given', async () => {
    const level = await define.execute({ context: context(), warehouseId, itemId, minimum: '5' })

    if (level.isLeft()) throw level.value
    expect(level.value.maximum).toBeNull()
  })

  it('takes a minimum of zero rather than a way to delete the level', async () => {
    // Silence about an item is not the same as a decision to ignore it, so the decision
    // is what gets written down.
    const level = await define.execute({ context: context(), warehouseId, itemId, minimum: '0' })

    if (level.isLeft()) throw level.value
    expect(level.value.minimum).toBe(0n)
  })

  it('restates a level rather than keeping two', async () => {
    await define.execute({ context: context(), warehouseId, itemId, minimum: '20' })

    await define.execute({ context: context(), warehouseId, itemId, minimum: '30' })

    expect(unitOfWork.levels).toHaveLength(1)
    expect(unitOfWork.levels[0]?.minimum).toBe(30_000_000n)
  })

  it('refuses a ceiling below the floor', async () => {
    const level = await define.execute({
      context: context(),
      warehouseId,
      itemId,
      minimum: '100',
      maximum: '20',
    })

    expect(level.isLeft()).toBe(true)
  })

  it('refuses a warehouse that does not exist', async () => {
    const level = await define.execute({
      context: context(),
      warehouseId: randomUUID(),
      itemId,
      minimum: '10',
    })

    if (level.isRight()) throw new Error('expected a refusal')
    expect(level.value.title).toBe('Resource not found')
  })

  it('names whoever set it in the audit chain', async () => {
    await define.execute({ context: context(), warehouseId, itemId, minimum: '20', maximum: '80' })

    const entry = unitOfWork.auditRecords.at(-1)
    expect(entry?.action).toBe('level.defined')
    expect(entry?.subjectType).toBe('level')
    expect(entry?.actor).toBe(PLANNER)
    expect(entry?.details).toMatchObject({ minimum: '20', maximum: '80' })
  })
})
