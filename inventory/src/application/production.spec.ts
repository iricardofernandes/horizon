import { randomUUID } from 'node:crypto'
import { InMemoryInventoryUnitOfWork } from 'test/repositories/in-memory-inventory-unit-of-work'
import { beforeEach, describe, expect, it } from 'vitest'
import { Quantity } from '@/domain/value-objects/inventory-values'
import { CreateWarehouseUseCase, ReceiveStockUseCase } from './use-cases/manage-inventory'
import {
  CancelProductionOrderUseCase,
  ChargeProductionUseCase,
  FinishProductionOrderUseCase,
  IssueMaterialUseCase,
  OpenProductionOrderUseCase,
  ReleaseProductionOrderUseCase,
  ScrapMaterialUseCase,
} from './use-cases/produce'

const now = new Date('2026-09-21T09:00:00.000Z')
const clock = { now: () => now }
const MAKER = 'user-maker'

let unitOfWork: InMemoryInventoryUnitOfWork
let tenantId: string
let warehouseId: string
let chair: string
let leg: string
let seat: string

const context = () => ({ tenantId, actor: MAKER, requestId: null })
const idempotent = () => ({ ...context(), idempotencyKey: randomUUID() })

function unwrap<E, T>(result: { isLeft(): boolean; isRight(): boolean; value: E | T }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

/** A recipe heard from the catalogue: one chair is one seat and four legs. */
const hearRecipe = (
  components: readonly { itemId: string; perUnit: string }[],
  options: { version?: number; realisation?: 'assembled' | 'exploded' } = {},
) => {
  unitOfWork.compositionsHeard.push({
    tenantId,
    composition: {
      parentItemId: chair,
      version: options.version ?? 1,
      realisation: options.realisation ?? 'assembled',
      effectiveFrom: '2026-01-01',
      components: components.map((component) => ({
        itemId: component.itemId,
        perUnit: unwrap(Quantity.create(component.perUnit)),
      })),
    },
  })
}

const stock = (itemId: string, quantity: string, unitCost: string) =>
  new ReceiveStockUseCase(unitOfWork, clock).execute({
    tenantId,
    warehouseId,
    itemId,
    quantity,
    unitCost,
    currency: 'BRL',
  })

const open = (quantity = '10') =>
  new OpenProductionOrderUseCase(unitOfWork, clock).execute({
    context: idempotent(),
    itemId: chair,
    warehouseId,
    quantity,
    note: null,
  })

const release = (orderId: string) =>
  new ReleaseProductionOrderUseCase(unitOfWork, clock).execute({
    context: context(),
    orderId,
    on: '2026-09-21',
  })

const issue = (orderId: string, itemId: string, quantity: string) =>
  new IssueMaterialUseCase(unitOfWork, clock).execute({
    context: idempotent(),
    orderId,
    itemId,
    quantity,
  })

const scrap = (orderId: string, itemId: string, quantity: string) =>
  new ScrapMaterialUseCase(unitOfWork, clock).execute({
    context: context(),
    orderId,
    itemId,
    quantity,
  })

const finish = (orderId: string, produced: string) =>
  new FinishProductionOrderUseCase(unitOfWork, clock).execute({
    context: idempotent(),
    orderId,
    produced,
  })

const held = (itemId: string) => unitOfWork.balances.find((balance) => balance.itemId() === itemId)

/** Opened, released and stocked with material: the state most tests start from. */
async function ready(quantity = '10') {
  hearRecipe([
    { itemId: seat, perUnit: '1' },
    { itemId: leg, perUnit: '4' },
  ])
  unwrap(await stock(seat, '100', '5000'))
  unwrap(await stock(leg, '400', '500'))
  const order = unwrap(await open(quantity))
  unwrap(await release(order.orderId))
  return order.orderId
}

beforeEach(async () => {
  unitOfWork = new InMemoryInventoryUnitOfWork()
  tenantId = randomUUID()
  chair = randomUUID()
  leg = randomUUID()
  seat = randomUUID()
  const warehouse = await new CreateWarehouseUseCase(unitOfWork, clock).execute({
    tenantId,
    name: 'Main',
  })
  if (warehouse.isLeft()) throw warehouse.value
  warehouseId = warehouse.value.warehouseId
})

describe('opening and releasing an order', () => {
  it('freezes the recipe multiplied out for what is being made', async () => {
    await ready('10')

    const order = unitOfWork.productionOrders[0]
    expect(order?.compositionVersion()).toBe(1)
    expect(order?.components().map((one) => [one.itemId, one.expected.toString()])).toEqual([
      [seat, '10'],
      [leg, '40'],
    ])
  })

  it('refuses to release against a recipe that does not exist yet', async () => {
    const order = unwrap(await open())

    const released = await release(order.orderId)

    expect(released.isLeft()).toBe(true)
  })

  it('refuses to make a bundle, which is something nobody assembles', async () => {
    hearRecipe([{ itemId: leg, perUnit: '4' }], { realisation: 'exploded' })
    const order = unwrap(await open())

    const released = await release(order.orderId)

    expect(released.isLeft()).toBe(true)
  })

  it('takes no material before it is released', async () => {
    hearRecipe([{ itemId: leg, perUnit: '4' }])
    unwrap(await stock(leg, '400', '500'))
    const order = unwrap(await open())

    const issued = await issue(order.orderId, leg, '4')

    expect(issued.isLeft()).toBe(true)
  })
})

describe('the material that goes in', () => {
  it('leaves the shelf at what it was worth there', async () => {
    const orderId = await ready()

    unwrap(await issue(orderId, seat, '10'))

    expect(held(seat)?.onHand().toString()).toBe('90')
    const component = unitOfWork.productionOrders[0]
      ?.components()
      .find((one) => one.itemId === seat)
    // Ten seats at 50.00: the order is carrying 500.00 of material.
    expect(component?.issuedValue?.amount).toBe(50_000n)
  })

  it('records more than the recipe asked for rather than refusing it', async () => {
    const orderId = await ready()

    // A batch that needed an extra seat needed it; refusing would leave the seat missing
    // from stock with nothing to explain where it went.
    const issued = await issue(orderId, seat, '12')

    expect(issued.isRight()).toBe(true)
    expect(held(seat)?.onHand().toString()).toBe('88')
  })

  it('refuses material the recipe never mentioned', async () => {
    const orderId = await ready()
    const bolt = randomUUID()
    unwrap(await stock(bolt, '100', '100'))

    const issued = await issue(orderId, bolt, '1')

    expect(issued.isLeft()).toBe(true)
  })
})

describe('what comes out, and what it is worth', () => {
  it('carries exactly what went into it', async () => {
    const orderId = await ready('10')
    unwrap(await issue(orderId, seat, '10'))
    unwrap(await issue(orderId, leg, '40'))

    const finished = unwrap(await finish(orderId, '10'))

    // 10 seats at 50.00 plus 40 legs at 5.00 is 700.00, over ten chairs: 70.00 each.
    expect(finished.unitCost).toBe('7000')
    expect(held(chair)?.onHand().toString()).toBe('10')
    expect(held(chair)?.unitCost()?.amount).toBe(7000n)
  })

  it('leaves the ruined material out of what the goods are worth', async () => {
    const orderId = await ready('10')
    unwrap(await issue(orderId, seat, '10'))
    unwrap(await issue(orderId, leg, '44'))
    // Four legs were splintered on the floor.
    unwrap(await scrap(orderId, leg, '4'))

    const finished = unwrap(await finish(orderId, '10'))

    // 500.00 of seats plus 220.00 of legs, less the 20.00 ruined: 700.00 over ten.
    expect(finished.unitCost).toBe('7000')
  })

  it('adds what the work cost to what the goods are worth', async () => {
    const orderId = await ready('10')
    unwrap(await issue(orderId, seat, '10'))
    unwrap(await issue(orderId, leg, '40'))
    unwrap(
      await new ChargeProductionUseCase(unitOfWork, clock).execute({
        context: context(),
        orderId,
        amount: '30000',
        currency: 'BRL',
        subcontractorPartyId: null,
      }),
    )

    const finished = unwrap(await finish(orderId, '10'))

    // 700.00 of material plus 300.00 of work, over ten chairs.
    expect(finished.unitCost).toBe('10000')
  })

  it('conserves value: what went in is what came out plus what was ruined', async () => {
    const orderId = await ready('10')
    unwrap(await issue(orderId, seat, '10'))
    unwrap(await issue(orderId, leg, '44'))
    unwrap(await scrap(orderId, leg, '4'))

    unwrap(await finish(orderId, '8'))

    const order = unitOfWork.productionOrders[0]
    const issued = order?.issuedValue()?.amount ?? 0n
    const scrapped = order?.scrappedValue()?.amount ?? 0n
    const output = order?.outputValue()?.amount ?? 0n
    expect(output + scrapped).toBe(issued)
  })

  it('lets a batch fail completely, if everything it took is accounted for', async () => {
    const orderId = await ready('10')
    unwrap(await issue(orderId, seat, '10'))
    unwrap(await scrap(orderId, seat, '10'))

    const finished = unwrap(await finish(orderId, '0'))

    expect(finished.unitCost).toBeNull()
    expect(held(chair)).toBeUndefined()
  })

  it('refuses a batch that produced nothing and lost nothing', async () => {
    const orderId = await ready('10')
    unwrap(await issue(orderId, seat, '10'))

    // The seats went somewhere. An order that let this pass would lose them silently.
    const finished = await finish(orderId, '0')

    expect(finished.isLeft()).toBe(true)
  })

  it('refuses to ruin more than was ever issued', async () => {
    const orderId = await ready('10')
    unwrap(await issue(orderId, seat, '2'))

    const scrapped = await scrap(orderId, seat, '3')

    expect(scrapped.isLeft()).toBe(true)
  })
})

describe('abandoning an order', () => {
  it('is free before anything has been drawn', async () => {
    const orderId = await ready()

    const cancelled = unwrap(
      await new CancelProductionOrderUseCase(unitOfWork, clock).execute({
        context: context(),
        orderId,
        reason: 'the customer changed their mind',
      }),
    )

    expect(cancelled.status).toBe('cancelled')
  })

  it('is refused once material has left the shelf', async () => {
    const orderId = await ready()
    unwrap(await issue(orderId, seat, '1'))

    // The seat is gone. Finish the order with whatever came out; do not pretend it
    // never happened.
    const cancelled = await new CancelProductionOrderUseCase(unitOfWork, clock).execute({
      context: context(),
      orderId,
      reason: 'the customer changed their mind',
    })

    expect(cancelled.isLeft()).toBe(true)
  })
})
