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

let instant = new Date('2026-09-20T09:00:00.000Z')
const clock = { now: () => instant }

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

/** A workspace that identifies one item unit by unit, with somewhere to move them to. */
async function named(): Promise<World> {
  instant = new Date('2026-09-20T09:00:00.000Z')
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
      tracking: 'serial',
    }),
  )
  return { tenantId, main, annex, itemId }
}

const receive = (world: World, warehouseId: string, serials: readonly string[]) =>
  new ReceiveStockUseCase(database, clock).execute({
    tenantId: world.tenantId,
    warehouseId,
    itemId: world.itemId,
    quantity: String(serials.length),
    unitCost: '1000',
    currency: 'BRL',
    serials,
  })

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
  unwrap(
    await database.inTenant(world.tenantId, (scope) =>
      new ShipReservationUseCase(clock).executeInScope(scope, {
        tenantId: world.tenantId,
        orderId,
        lines: [{ lineId, quantity }],
      }),
    ),
  )
  return { orderId, lineId }
}

const whereabouts = async (tenantId: string) => {
  const rows = await administrator`select s.serial, s.status, b.warehouse_id
    from stock_serials s left join stock_balances b on b.id = s.balance_id
    where s.tenant_id = ${tenantId} order by s.serial`
  return rows.map((row) => [row.serial, row.status])
}

it('refuses goods that do not name their units, and takes them when they do', async () => {
  const world = await named()

  const unnamed = await receive(world, world.main, [])
  const given = await receive(world, world.main, ['sn-1', 'SN-2'])

  expect(unnamed.isLeft()).toBe(true)
  expect(given.isRight()).toBe(true)
  // Read off a plate by a person, so the case a person typed is not what identifies it.
  expect(await whereabouts(world.tenantId)).toEqual([
    ['SN-1', 'in-stock'],
    ['SN-2', 'in-stock'],
  ])
})

it('keeps the units adding up to the balance, and says so from the database too', async () => {
  const world = await named()
  unwrap(await receive(world, world.main, ['SN-1', 'SN-2', 'SN-3']))

  const [balance] = await administrator`select id, on_hand from stock_balances
    where tenant_id = ${world.tenantId} and warehouse_id = ${world.main}`
  expect(String(balance?.on_hand)).toBe('3000000')

  await expect(
    administrator`update stock_serials set status = 'scrapped', balance_id = null
      where tenant_id = ${world.tenantId} and serial = 'SN-1'`,
  ).rejects.toThrow('units are named on it')
})

it('will not let one unit be in two places at once', async () => {
  const world = await named()
  unwrap(await receive(world, world.main, ['SN-1']))

  // The same name arriving at the other warehouse is the same unit, and it is not there.
  const twice = await receive(world, world.annex, ['SN-1'])

  expect(twice.isLeft()).toBe(true)
})

it('sends what has been here longest and records which unit went', async () => {
  const world = await named()
  unwrap(await receive(world, world.main, ['SN-OLD']))
  instant = new Date('2026-09-21T09:00:00.000Z')
  unwrap(await receive(world, world.main, ['SN-NEW']))

  const order = await sell(world, world.main, '1')

  expect(await whereabouts(world.tenantId)).toEqual([
    ['SN-NEW', 'in-stock'],
    ['SN-OLD', 'shipped'],
  ])
  const trace = await database.traceSerial(world.tenantId, {
    itemId: world.itemId,
    serial: 'SN-OLD',
    limit: 50,
    offset: 0,
  })
  expect(trace?.status).toBe('shipped')
  expect(trace?.warehouseId).toBeNull()
  expect(trace?.steps.map((step) => [step.kind, step.quantity, step.document?.type])).toEqual([
    ['receipt', '1', undefined],
    ['shipment', '1', 'order'],
  ])
  expect(trace?.steps.at(-1)?.document?.id).toBe(order.orderId)
})

it('moves the very same units between warehouses', async () => {
  const world = await named()
  unwrap(await receive(world, world.main, ['SN-1', 'SN-2', 'SN-3']))

  unwrap(
    await new TransferStockUseCase(database, clock).execute({
      context: idempotent(world.tenantId),
      sourceWarehouseId: world.main,
      destinationWarehouseId: world.annex,
      lines: [{ itemId: world.itemId, quantity: '2', serials: ['SN-2', 'SN-3'] }],
      note: null,
    }),
  )

  const rows = await administrator`select s.serial, b.warehouse_id
    from stock_serials s join stock_balances b on b.id = s.balance_id
    where s.tenant_id = ${world.tenantId} order by s.serial`
  expect(rows.map((row) => [row.serial, row.warehouse_id === world.annex])).toEqual([
    ['SN-1', false],
    ['SN-2', true],
    ['SN-3', true],
  ])
})

it('takes the very unit back from a customer, onto the shelf it left', async () => {
  const world = await named()
  unwrap(await receive(world, world.main, ['SN-1', 'SN-2']))
  const order = await sell(world, world.main, '1')

  await database.inTenant(world.tenantId, (scope) =>
    new ReturnToStockUseCase(clock).executeInScope(scope, {
      tenantId: world.tenantId,
      orderId: order.orderId,
      lines: [{ lineId: order.lineId, quantity: '1' }],
    }),
  )

  expect(await whereabouts(world.tenantId)).toEqual([
    ['SN-1', 'in-stock'],
    ['SN-2', 'in-stock'],
  ])
  const trace = await database.traceSerial(world.tenantId, {
    itemId: world.itemId,
    serial: 'SN-1',
    limit: 50,
    offset: 0,
  })
  expect(trace?.steps.map((step) => step.kind)).toEqual(['receipt', 'shipment', 'return-in'])
})

it('counts a unit-tracked item by looking for each one', async () => {
  const world = await named()
  unwrap(await receive(world, world.main, ['SN-1', 'SN-2', 'SN-3']))
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
  expect(opened.lines).toBe(3)
  const sheet = await database.countDetail(world.tenantId, opened.countId)
  expect(sheet?.lines.map((line) => [line.serial, line.expected])).toEqual([
    ['SN-1', '1'],
    ['SN-2', '1'],
    ['SN-3', '1'],
  ])

  // Counting zero of a line is how a counter says the machine is not where it should be.
  unwrap(
    await new RecordStockCountUseCase(database, clock).execute({
      context: context(world.tenantId),
      countId: opened.countId,
      counts: [{ itemId: world.itemId, serial: 'SN-2', counted: '0' }],
    }),
  )
  unwrap(
    await new CloseStockCountUseCase(database, clock).execute({
      context: context(world.tenantId),
      countId: opened.countId,
    }),
  )

  expect(await whereabouts(world.tenantId)).toEqual([
    ['SN-1', 'in-stock'],
    ['SN-2', 'scrapped'],
    ['SN-3', 'in-stock'],
  ])
})

it('writes off the units somebody named, and remembers they were ours', async () => {
  const world = await named()
  unwrap(await receive(world, world.main, ['SN-1', 'SN-2', 'SN-3']))
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
      serials: ['SN-1', 'SN-3'],
      quantity: '2',
      reason: 'breakage',
      note: 'a pallet went over',
    }),
  )

  expect(await whereabouts(world.tenantId)).toEqual([
    ['SN-1', 'scrapped'],
    ['SN-2', 'in-stock'],
    ['SN-3', 'scrapped'],
  ])
  const listed = await database.listSerials(world.tenantId, {
    warehouseId: null,
    itemId: null,
    status: 'scrapped',
    limit: 50,
    offset: 0,
  })
  expect(listed.map((row) => row.serial)).toEqual(['SN-1', 'SN-3'])
})

it('keeps one workspace’s units out of another’s', async () => {
  const ours = await named()
  const theirs = await named()
  unwrap(await receive(ours, ours.main, ['SHARED']))
  unwrap(await receive(theirs, theirs.main, ['SHARED']))

  const trace = await database.traceSerial(ours.tenantId, {
    itemId: ours.itemId,
    serial: 'SHARED',
    limit: 50,
    offset: 0,
  })

  expect(trace?.steps).toHaveLength(1)
  expect(trace?.warehouseId).toBe(ours.main)
})
