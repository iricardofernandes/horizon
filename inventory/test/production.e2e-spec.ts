import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { InventoryCatalogEventHandlers } from '@/application/consume-catalog-events'
import {
  CreateWarehouseUseCase,
  ReceiveStockUseCase,
} from '@/application/use-cases/manage-inventory'
import {
  ChargeProductionUseCase,
  FinishProductionOrderUseCase,
  IssueMaterialUseCase,
  OpenProductionOrderUseCase,
  ReleaseProductionOrderUseCase,
  ScrapMaterialUseCase,
} from '@/application/use-cases/produce'
import type { Either } from '@/core/either'
import { InventoryDatabase } from '@/infrastructure/database/drizzle/inventory-database'

const clock = { now: () => new Date() }
const MAKER = 'user-maker'

let database: InventoryDatabase
let administrator: ReturnType<typeof postgres>

beforeAll(() => {
  database = new InventoryDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end()])
})

const today = () => clock.now().toISOString().slice(0, 10)
const context = (tenantId: string) => ({ tenantId, actor: MAKER, requestId: null })
const idempotent = (tenantId: string) => ({
  ...context(tenantId),
  idempotencyKey: randomUUID(),
})

function unwrap<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

interface World {
  readonly tenantId: string
  readonly warehouseId: string
  readonly chair: string
  readonly seat: string
  readonly leg: string
}

/**
 * A workshop that has heard a recipe and has the material on the shelf.
 *
 * The recipe arrives the way it really does — as the catalogue's event — so the test
 * exercises the projection rather than a table somebody seeded by hand.
 */
async function workshop(realisation: 'assembled' | 'exploded' = 'assembled'): Promise<World> {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const warehouseId = unwrap(
    await new CreateWarehouseUseCase(database, clock).execute({ tenantId, name: 'Main' }),
  ).warehouseId
  const chair = randomUUID()
  const seat = randomUUID()
  const leg = randomUUID()

  await new InventoryCatalogEventHandlers(database, clock).handlers[
    'catalog.composition.defined'
  ]?.({
    eventId: randomUUID(),
    eventType: 'catalog.composition.defined',
    eventVersion: 1,
    tenantId,
    occurredAt: new Date().toISOString(),
    traceId: randomUUID().replace(/-/g, ''),
    payload: {
      compositionId: randomUUID(),
      parentItemId: chair,
      version: 1,
      realisation,
      effectiveFrom: '2026-01-01',
      lines: [
        { componentItemId: seat, quantity: '1' },
        { componentItemId: leg, quantity: '4' },
      ],
    },
  } as never)

  const receive = new ReceiveStockUseCase(database, clock)
  unwrap(
    await receive.execute({
      tenantId,
      warehouseId,
      itemId: seat,
      quantity: '100',
      unitCost: '5000',
      currency: 'BRL',
    }),
  )
  unwrap(
    await receive.execute({
      tenantId,
      warehouseId,
      itemId: leg,
      quantity: '400',
      unitCost: '500',
      currency: 'BRL',
    }),
  )
  return { tenantId, warehouseId, chair, seat, leg }
}

const openAndRelease = async (world: World, quantity = '10') => {
  const order = unwrap(
    await new OpenProductionOrderUseCase(database, clock).execute({
      context: idempotent(world.tenantId),
      itemId: world.chair,
      warehouseId: world.warehouseId,
      quantity,
      note: null,
    }),
  )
  unwrap(
    await new ReleaseProductionOrderUseCase(database, clock).execute({
      context: context(world.tenantId),
      orderId: order.orderId,
      on: today(),
    }),
  )
  return order.orderId
}

const issue = (world: World, orderId: string, itemId: string, quantity: string) =>
  new IssueMaterialUseCase(database, clock).execute({
    context: idempotent(world.tenantId),
    orderId,
    itemId,
    quantity,
  })

const finish = (world: World, orderId: string, produced: string) =>
  new FinishProductionOrderUseCase(database, clock).execute({
    context: idempotent(world.tenantId),
    orderId,
    produced,
  })

const balanceOf = async (tenantId: string, itemId: string) => {
  const [row] = await administrator`select on_hand, average_unit_cost from stock_balances
    where tenant_id = ${tenantId} and item_id = ${itemId}`
  return row
}

it('hears the catalogue’s recipe and releases against the version in force', async () => {
  const world = await workshop()

  const orderId = await openAndRelease(world, '10')

  const detail = await database.productionOrderDetail(world.tenantId, orderId)
  expect(detail?.status).toBe('released')
  expect(detail?.compositionVersion).toBe(1)
  expect(detail?.components.map((one) => [one.itemId, one.expected])).toEqual([
    ...[
      [world.seat, '10'],
      [world.leg, '40'],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ])
})

it('takes material off the shelf as production, not as a write-off', async () => {
  const world = await workshop()
  const orderId = await openAndRelease(world)

  unwrap(await issue(world, orderId, world.seat, '10'))

  const movements = await administrator`select kind, reason, document_type from stock_movements
    where tenant_id = ${world.tenantId} and item_id = ${world.seat} order by balance_version`
  expect(movements.map((row) => [row.kind, row.reason, row.document_type])).toEqual([
    ['receipt', null, null],
    ['production-out', 'production', 'production-order'],
  ])
})

it('puts the finished goods on the shelf worth exactly what went into them', async () => {
  const world = await workshop()
  const orderId = await openAndRelease(world, '10')
  unwrap(await issue(world, orderId, world.seat, '10'))
  unwrap(await issue(world, orderId, world.leg, '40'))

  const finished = unwrap(await finish(world, orderId, '10'))

  // Ten seats at 50.00 and forty legs at 5.00 is 700.00, over ten chairs: 70.00 each.
  expect(finished.unitCost).toBe('7000')
  const chair = await balanceOf(world.tenantId, world.chair)
  expect(String(chair?.on_hand)).toBe('10000000')
  expect(String(chair?.average_unit_cost)).toBe('7000')
  const kardex = await database.kardex(world.tenantId, {
    itemId: world.chair,
    warehouseId: world.warehouseId,
    from: '2026-01-01T00:00:00.000Z',
    to: new Date(Date.now() + 60_000).toISOString(),
    limit: 200,
    offset: 0,
  })
  expect(kardex.lines.map((line) => [line.kind, line.direction])).toEqual([['production-in', 'in']])
})

it('conserves value across the whole order, asserted against the database', async () => {
  const world = await workshop()
  const orderId = await openAndRelease(world, '10')
  unwrap(await issue(world, orderId, world.seat, '10'))
  unwrap(await issue(world, orderId, world.leg, '44'))
  unwrap(
    await new ScrapMaterialUseCase(database, clock).execute({
      context: context(world.tenantId),
      orderId,
      itemId: world.leg,
      quantity: '4',
    }),
  )
  unwrap(await finish(world, orderId, '10'))

  const [sums] = await administrator`select
      coalesce(sum(issued_value), 0) as issued,
      coalesce(sum(scrapped_value), 0) as scrapped
    from production_order_components
    where tenant_id = ${world.tenantId} and order_id = ${orderId}`
  const chair = await balanceOf(world.tenantId, world.chair)
  const produced = (BigInt(chair?.on_hand) * BigInt(chair?.average_unit_cost)) / 1_000_000n
  // Nothing was created and nothing was lost between the two shelves.
  expect(produced + BigInt(sums?.scrapped)).toBe(BigInt(sums?.issued))
})

it('adds a subcontractor’s bill to what the goods are worth', async () => {
  const world = await workshop()
  const orderId = await openAndRelease(world, '10')
  unwrap(await issue(world, orderId, world.seat, '10'))
  unwrap(await issue(world, orderId, world.leg, '40'))
  const subcontractor = randomUUID()
  unwrap(
    await new ChargeProductionUseCase(database, clock).execute({
      context: context(world.tenantId),
      orderId,
      amount: '30000',
      currency: 'BRL',
      subcontractorPartyId: subcontractor,
    }),
  )

  const finished = unwrap(await finish(world, orderId, '10'))

  expect(finished.unitCost).toBe('10000')
  const detail = await database.productionOrderDetail(world.tenantId, orderId)
  expect(detail?.subcontractorPartyId).toBe(subcontractor)
  expect(detail?.outputValue?.amount).toBe('100000')
})

it('refuses a bundle, which is something nobody assembles', async () => {
  const world = await workshop('exploded')

  const order = unwrap(
    await new OpenProductionOrderUseCase(database, clock).execute({
      context: idempotent(world.tenantId),
      itemId: world.chair,
      warehouseId: world.warehouseId,
      quantity: '1',
      note: null,
    }),
  )
  const released = await new ReleaseProductionOrderUseCase(database, clock).execute({
    context: context(world.tenantId),
    orderId: order.orderId,
    on: today(),
  })

  expect(released.isLeft()).toBe(true)
})

it('refuses an order that produced nothing and accounted for nothing, in the database too', async () => {
  const world = await workshop()
  const orderId = await openAndRelease(world, '10')
  unwrap(await issue(world, orderId, world.seat, '10'))

  const finished = await finish(world, orderId, '0')
  expect(finished.isLeft()).toBe(true)

  // And the trigger says so as well, whatever gets past the aggregate.
  await expect(
    administrator`update production_orders set status = 'finished', produced = 0
      where tenant_id = ${world.tenantId} and id = ${orderId}`,
  ).rejects.toThrow(/accounted for as ruined/)
})

it('keeps one workspace’s orders out of another’s', async () => {
  const ours = await workshop()
  const theirs = await workshop()
  const ourOrder = await openAndRelease(ours, '10')
  await openAndRelease(theirs, '5')

  const listed = await database.listProductionOrders(ours.tenantId, {
    status: null,
    warehouseId: null,
    limit: 50,
    offset: 0,
  })

  expect(listed.map((row) => row.id)).toEqual([ourOrder])
})
