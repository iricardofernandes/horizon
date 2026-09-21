import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AdjustStockUseCase } from '@/application/use-cases/adjust-stock'
import { ConfirmReservationUseCase } from '@/application/use-cases/confirm-reservation'
import {
  CloseStockCountUseCase,
  OpenStockCountUseCase,
  RecordStockCountUseCase,
} from '@/application/use-cases/count-stock'
import {
  DefineAdjustmentPolicyUseCase,
  DefineItemTrackingUseCase,
} from '@/application/use-cases/define-policies'
import {
  CreateWarehouseUseCase,
  ReceiveStockUseCase,
} from '@/application/use-cases/manage-inventory'
import { ReserveStockUseCase } from '@/application/use-cases/reserve-stock'
import {
  ReturnToStockUseCase,
  ShipReservationUseCase,
} from '@/application/use-cases/ship-reservation'
import { TransferStockUseCase } from '@/application/use-cases/transfer-stock'
import type { Either } from '@/core/either'
import { InventoryDatabase } from '@/infrastructure/database/drizzle/inventory-database'

const KEEPER = 'user-keeper'
const MANAGER = 'user-manager'

let instant = new Date()
const clock = { now: () => instant }

/**
 * Expiry dates relative to the day the suite runs, never written into the source.
 *
 * Whether a lot has gone off is judged against today — by the aggregate and by
 * `current_date` in the reports — so a date in the source is a test that passes until the
 * morning the calendar reaches it.
 */
const day = (offset: number) => {
  const when = new Date(instant)
  when.setUTCDate(when.getUTCDate() + offset)
  return when.toISOString().slice(0, 10)
}
const GONE = day(-20)
const SOON = day(40)
const MIDDLE = day(100)
const LATER = day(400)

let database: InventoryDatabase
let administrator: ReturnType<typeof postgres>

beforeAll(() => {
  database = new InventoryDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end()])
})

const context = (tenantId: string, actor = KEEPER) => ({ tenantId, actor, requestId: null })
const idempotent = (tenantId: string, actor = KEEPER) => ({
  ...context(tenantId, actor),
  idempotencyKey: randomUUID(),
})

function unwrap<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

interface World {
  readonly tenantId: string
  readonly main: string
  readonly annex: string
  readonly itemId: string
}

/** A workspace that identifies one item by lot, with two warehouses to move it between. */
async function tracked(expiry: 'none' | 'optional' | 'required' = 'optional'): Promise<World> {
  instant = new Date()
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const warehouses = new CreateWarehouseUseCase(database, clock)
  const main = unwrap(await warehouses.execute({ tenantId, name: 'Main' })).warehouseId
  const annex = unwrap(await warehouses.execute({ tenantId, name: 'Annex' })).warehouseId
  const itemId = randomUUID()
  unwrap(
    await new DefineItemTrackingUseCase(database, clock).execute({
      context: context(tenantId),
      itemId,
      tracking: 'lot',
      expiry,
    }),
  )
  return { tenantId, main, annex, itemId }
}

const receive = (
  world: World,
  warehouseId: string,
  lots: readonly { code: string; expiresOn?: string | null; quantity: string }[],
) =>
  new ReceiveStockUseCase(database, clock).execute({
    tenantId: world.tenantId,
    warehouseId,
    itemId: world.itemId,
    quantity: lots.reduce((total, lot) => total + Number(lot.quantity), 0).toString(),
    unitCost: '1000',
    currency: 'BRL',
    lots,
  })

/** An order placed, confirmed and sent; returns the order it was. */
async function sell(world: World, warehouseId: string, quantity: string) {
  const orderId = randomUUID()
  const lineId = randomUUID()
  const reserved = unwrap(
    await new ReserveStockUseCase(database, clock, 86_400).execute({
      tenantId: world.tenantId,
      orderId,
      orderVersion: 1,
      fulfillmentWarehouseId: warehouseId,
      lines: [{ lineId, itemId: world.itemId, quantity }],
    }),
  )
  if (!reserved.reserved) throw new Error('the fixture could not reserve its own stock')
  unwrap(
    await new ConfirmReservationUseCase(database, clock).execute({
      tenantId: world.tenantId,
      orderId,
      orderVersion: 2,
      reservationId: reserved.reservationId,
    }),
  )
  const shipped = await database.inTenant(world.tenantId, (scope) =>
    new ShipReservationUseCase(clock).executeInScope(scope, {
      tenantId: world.tenantId,
      orderId,
      lines: [{ lineId, quantity }],
    }),
  )
  return { orderId, lineId, shipped }
}

const lotsOn = async (tenantId: string, warehouseId: string) => {
  const rows = await administrator`select l.lot_code, l.on_hand, l.expires_on
    from stock_lots l join stock_balances b on b.id = l.balance_id
    where l.tenant_id = ${tenantId} and b.warehouse_id = ${warehouseId}
    order by l.expires_on asc nulls last, l.lot_code`
  return rows.map((row) => [row.lot_code, String(row.on_hand)])
}

it('refuses goods that do not say which lot they are, and takes them when they do', async () => {
  const world = await tracked()

  const unnamed = await receive(world, world.main, [])
  const named = await receive(world, world.main, [{ code: 'ab-1204', quantity: '10' }])

  expect(unnamed.isLeft()).toBe(true)
  expect(named.isRight()).toBe(true)
  // Read off a carton by a person, so the case a person typed is not what identifies it.
  expect(await lotsOn(world.tenantId, world.main)).toEqual([['AB-1204', '10000000']])
})

it('keeps the lots adding up to the balance, and says so from the database too', async () => {
  const world = await tracked()
  unwrap(await receive(world, world.main, [{ code: 'AB-1', quantity: '6' }]))
  unwrap(await receive(world, world.main, [{ code: 'AB-2', quantity: '4' }]))

  const [balance] = await administrator`select id, on_hand from stock_balances
    where tenant_id = ${world.tenantId} and warehouse_id = ${world.main}`
  const [lots] = await administrator`select coalesce(sum(on_hand), 0) as total from stock_lots
    where balance_id = ${balance?.id}`
  expect(String(lots?.total)).toBe(String(balance?.on_hand))

  // And the trigger refuses to let them drift apart, whatever gets past the aggregate.
  await expect(
    administrator`update stock_lots set on_hand = on_hand + 1000000 where balance_id = ${balance?.id}`,
  ).rejects.toThrow('the lots of balance')
})

it('sends the earliest date first and says which boxes went', async () => {
  const world = await tracked()
  unwrap(await receive(world, world.main, [{ code: 'LATE', expiresOn: LATER, quantity: '10' }]))
  unwrap(await receive(world, world.main, [{ code: 'SOON', expiresOn: SOON, quantity: '10' }]))

  const order = await sell(world, world.main, '12')

  expect(unwrap(order.shipped)).toBeUndefined()
  expect(await lotsOn(world.tenantId, world.main)).toEqual([['LATE', '8000000']])
  const trace = await database.traceLot(world.tenantId, {
    itemId: world.itemId,
    code: 'SOON',
    limit: 50,
    offset: 0,
  })
  expect(trace.onHand).toBe('0')
  expect(trace.steps.map((step) => [step.kind, step.quantity, step.document?.type])).toEqual([
    ['receipt', '10', undefined],
    ['shipment', '10', 'order'],
  ])
  expect(trace.steps.at(-1)?.document?.id).toBe(order.orderId)
})

it('will not promise, or send, stock whose day has gone by', async () => {
  const world = await tracked()
  unwrap(await receive(world, world.main, [{ code: 'GONE', expiresOn: GONE, quantity: '10' }]))
  unwrap(await receive(world, world.main, [{ code: 'GOOD', expiresOn: MIDDLE, quantity: '4' }]))

  const [position] = await database.stockPosition(world.tenantId, {
    warehouseId: world.main,
    itemId: world.itemId,
    limit: 10,
    offset: 0,
  })

  // Still owned, still on the shelf, and promisable to nobody.
  expect(position).toMatchObject({ onHand: '14', expired: '10', available: '4' })
  const tooMuch = await new ReserveStockUseCase(database, clock, 86_400).execute({
    tenantId: world.tenantId,
    orderId: randomUUID(),
    orderVersion: 1,
    fulfillmentWarehouseId: world.main,
    lines: [{ lineId: randomUUID(), itemId: world.itemId, quantity: '5' }],
  })
  const outcome = unwrap(tooMuch)
  expect(outcome.reserved).toBe(false)
})

it('lists what is about to go off, worst first', async () => {
  const world = await tracked()
  unwrap(await receive(world, world.main, [{ code: 'GONE', expiresOn: GONE, quantity: '3' }]))
  unwrap(await receive(world, world.main, [{ code: 'SOON', expiresOn: SOON, quantity: '3' }]))
  unwrap(await receive(world, world.main, [{ code: 'LATER', expiresOn: LATER, quantity: '3' }]))

  const lots = await database.listLots(world.tenantId, {
    warehouseId: null,
    itemId: null,
    expiringBy: day(60),
    limit: 50,
    offset: 0,
  })

  expect(lots.map((lot) => [lot.code, lot.expired])).toEqual([
    ['GONE', true],
    ['SOON', false],
  ])
})

it('moves the very same boxes between warehouses, dates and all', async () => {
  const world = await tracked()
  unwrap(await receive(world, world.main, [{ code: 'SOON', expiresOn: SOON, quantity: '6' }]))
  unwrap(await receive(world, world.main, [{ code: 'LATE', expiresOn: LATER, quantity: '6' }]))

  unwrap(
    await new TransferStockUseCase(database, clock).execute({
      context: idempotent(world.tenantId),
      sourceWarehouseId: world.main,
      destinationWarehouseId: world.annex,
      lines: [{ itemId: world.itemId, quantity: '8' }],
      note: null,
    }),
  )

  expect(await lotsOn(world.tenantId, world.main)).toEqual([['LATE', '4000000']])
  expect(await lotsOn(world.tenantId, world.annex)).toEqual([
    ['SOON', '6000000'],
    ['LATE', '2000000'],
  ])
  const [arrived] = await administrator`select expires_on::text from stock_lots l
    join stock_balances b on b.id = l.balance_id
    where b.warehouse_id = ${world.annex} and l.lot_code = 'SOON'`
  expect(arrived?.expires_on).toBe(SOON)
})

it('puts a customer return back into the very lots it went out in', async () => {
  const world = await tracked()
  unwrap(await receive(world, world.main, [{ code: 'SOON', expiresOn: SOON, quantity: '5' }]))
  unwrap(await receive(world, world.main, [{ code: 'LATE', expiresOn: LATER, quantity: '5' }]))
  const order = await sell(world, world.main, '7')

  await database.inTenant(world.tenantId, (scope) =>
    new ReturnToStockUseCase(clock).executeInScope(scope, {
      tenantId: world.tenantId,
      orderId: order.orderId,
      lines: [{ lineId: order.lineId, quantity: '5' }],
    }),
  )

  // Five went out of SOON and two out of LATE; five coming back go into the larger of the
  // two first, which is the only allocation the shipment itself supports.
  expect(await lotsOn(world.tenantId, world.main)).toEqual([
    ['SOON', '5000000'],
    ['LATE', '3000000'],
  ])
})

it('counts a tracked item lot by lot and posts the difference against that lot', async () => {
  const world = await tracked()
  unwrap(await receive(world, world.main, [{ code: 'AB-1', expiresOn: MIDDLE, quantity: '10' }]))
  unwrap(await receive(world, world.main, [{ code: 'AB-2', expiresOn: LATER, quantity: '10' }]))
  unwrap(
    await new DefineAdjustmentPolicyUseCase(database, clock).execute({
      context: context(world.tenantId, MANAGER),
      currency: 'BRL',
      threshold: '1000000',
    }),
  )

  const opened = unwrap(
    await new OpenStockCountUseCase(database, clock).execute({
      context: idempotent(world.tenantId),
      warehouseId: world.main,
      itemIds: null,
      note: null,
    }),
  )
  expect(opened.lines).toBe(2)
  const sheet = await database.countDetail(world.tenantId, opened.countId)
  expect(sheet?.lines.map((line) => [line.lot, line.expected])).toEqual([
    ['AB-1', '10'],
    ['AB-2', '10'],
  ])

  unwrap(
    await new RecordStockCountUseCase(database, clock).execute({
      context: context(world.tenantId),
      countId: opened.countId,
      counts: [{ itemId: world.itemId, lot: 'AB-2', counted: '8' }],
    }),
  )
  unwrap(
    await new CloseStockCountUseCase(database, clock).execute({
      context: context(world.tenantId),
      countId: opened.countId,
    }),
  )

  // The shelf is two short, and the useful answer is which lot is two short.
  expect(await lotsOn(world.tenantId, world.main)).toEqual([
    ['AB-1', '10000000'],
    ['AB-2', '8000000'],
  ])
})

it('writes off the lot somebody named, expired or not', async () => {
  const world = await tracked()
  unwrap(await receive(world, world.main, [{ code: 'GONE', expiresOn: GONE, quantity: '6' }]))
  unwrap(await receive(world, world.main, [{ code: 'GOOD', expiresOn: MIDDLE, quantity: '6' }]))
  unwrap(
    await new DefineAdjustmentPolicyUseCase(database, clock).execute({
      context: context(world.tenantId, MANAGER),
      currency: 'BRL',
      threshold: '1000000',
    }),
  )

  unwrap(
    await new AdjustStockUseCase(database, clock).execute({
      context: idempotent(world.tenantId),
      warehouseId: world.main,
      itemId: world.itemId,
      direction: 'out',
      lot: 'GONE',
      quantity: '6',
      reason: 'expiry',
      note: 'past its date',
    }),
  )

  expect(await lotsOn(world.tenantId, world.main)).toEqual([['GOOD', '6000000']])
})

it('keeps one workspace’s lots out of another’s trace', async () => {
  const ours = await tracked()
  const theirs = await tracked()
  unwrap(await receive(ours, ours.main, [{ code: 'SHARED', quantity: '4' }]))
  unwrap(await receive(theirs, theirs.main, [{ code: 'SHARED', quantity: '9' }]))

  const trace = await database.traceLot(ours.tenantId, {
    itemId: ours.itemId,
    code: 'SHARED',
    limit: 50,
    offset: 0,
  })

  expect(trace.onHand).toBe('4')
  expect(trace.steps).toHaveLength(1)
})
