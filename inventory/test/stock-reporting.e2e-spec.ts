import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AdjustStockUseCase } from '@/application/use-cases/adjust-stock'
import { ConfirmReservationUseCase } from '@/application/use-cases/confirm-reservation'
import {
  DefineAdjustmentPolicyUseCase,
  DefineStockLevelUseCase,
} from '@/application/use-cases/define-policies'
import {
  CreateWarehouseUseCase,
  ReceiveStockUseCase,
} from '@/application/use-cases/manage-inventory'
import { ReserveStockUseCase } from '@/application/use-cases/reserve-stock'
import { ShipReservationUseCase } from '@/application/use-cases/ship-reservation'
import { TransferStockUseCase } from '@/application/use-cases/transfer-stock'
import type { Either } from '@/core/either'
import { InventoryDatabase } from '@/infrastructure/database/drizzle/inventory-database'

const KEEPER = 'user-keeper'
const MANAGER = 'user-manager'

/** A clock the fixture winds forward, so "as of" has something to be as of. */
let instant = new Date('2026-06-01T09:00:00.000Z')
const clock = { now: () => instant }
const at = (day: string) => {
  instant = new Date(`2026-06-${day}T09:00:00.000Z`)
}

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
  readonly widget: string
  readonly bolt: string
}

/**
 * A fortnight of a small warehouse, built through the use cases rather than seeded.
 *
 * Widgets: a hundred bought at 10.00, a hundred more at 20.00 — so a widget is worth
 * 15.00 — twenty sold, thirty moved to the annex. Bolts: forty at 5.00, four sold, five
 * dropped. Every figure the reports are asked for is derivable by hand from that.
 */
async function fortnight(): Promise<World> {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const warehouses = new CreateWarehouseUseCase(database, clock)
  const receive = new ReceiveStockUseCase(database, clock)
  const widget = randomUUID()
  const bolt = randomUUID()

  at('01')
  const main = unwrap(await warehouses.execute({ tenantId, name: 'Main' })).warehouseId
  const annex = unwrap(await warehouses.execute({ tenantId, name: 'Annex' })).warehouseId

  at('02')
  unwrap(
    await receive.execute({
      tenantId,
      warehouseId: main,
      itemId: widget,
      quantity: '100',
      unitCost: '1000',
      currency: 'BRL',
    }),
  )
  at('03')
  unwrap(
    await receive.execute({
      tenantId,
      warehouseId: main,
      itemId: widget,
      quantity: '100',
      unitCost: '2000',
      currency: 'BRL',
    }),
  )
  at('04')
  unwrap(
    await receive.execute({
      tenantId,
      warehouseId: main,
      itemId: bolt,
      quantity: '40',
      unitCost: '500',
      currency: 'BRL',
    }),
  )

  at('05')
  await sell(tenantId, main, [{ itemId: widget, quantity: '20' }])
  at('06')
  await sell(tenantId, main, [{ itemId: bolt, quantity: '4' }])

  at('07')
  unwrap(
    await new TransferStockUseCase(database, clock).execute({
      context: idempotent(tenantId),
      sourceWarehouseId: main,
      destinationWarehouseId: annex,
      lines: [{ itemId: widget, quantity: '30' }],
      note: null,
    }),
  )

  at('08')
  unwrap(
    await new DefineAdjustmentPolicyUseCase(database, clock).execute({
      context: context(tenantId, MANAGER),
      currency: 'BRL',
      threshold: '1000000',
    }),
  )
  unwrap(
    await new AdjustStockUseCase(database, clock).execute({
      context: idempotent(tenantId),
      warehouseId: main,
      itemId: bolt,
      direction: 'out',
      quantity: '5',
      reason: 'breakage',
      note: 'a pallet went over',
    }),
  )

  at('20')
  return { tenantId, main, annex, widget, bolt }
}

/** An order placed, confirmed and sent, which is the only way stock leaves for a customer. */
async function sell(
  tenantId: string,
  warehouseId: string,
  items: readonly { itemId: string; quantity: string }[],
) {
  const orderId = randomUUID()
  const lines = items.map((item) => ({ lineId: randomUUID(), ...item }))
  const reserved = unwrap(
    await new ReserveStockUseCase(database, clock, 3600).execute({
      tenantId,
      orderId,
      orderVersion: 1,
      fulfillmentWarehouseId: warehouseId,
      lines,
    }),
  )
  if (!reserved.reserved) throw new Error('the fixture could not reserve its own stock')
  unwrap(
    await new ConfirmReservationUseCase(database, clock).execute({
      tenantId,
      orderId,
      // Confirming is a later version of the order than the one that placed it.
      orderVersion: 2,
      reservationId: reserved.reservationId,
    }),
  )
  await database.inTenant(tenantId, (scope) =>
    new ShipReservationUseCase(clock).executeInScope(scope, {
      tenantId,
      orderId,
      lines: lines.map((line) => ({ lineId: line.lineId, quantity: line.quantity })),
    }),
  )
}

const now = () => new Date().toISOString()

it('values the whole company from the movements alone, and agrees with the balances', async () => {
  const world = await fortnight()

  const valued = await database.valuation(world.tenantId, { asOf: now(), warehouseId: null })

  // Read straight back off the balance table, which the report never consults.
  const balances = await administrator`select item_id, warehouse_id, on_hand, average_unit_cost
    from stock_balances where tenant_id = ${world.tenantId} and on_hand > 0
    order by warehouse_id, item_id`
  expect(valued.rows).toHaveLength(balances.length)
  const held = new Map(valued.rows.map((row) => [`${row.warehouseId}:${row.itemId}`, row]))
  for (const balance of balances) {
    const row = held.get(`${balance.warehouse_id}:${balance.item_id}`)
    expect(row?.unitCost?.amount).toBe(String(balance.average_unit_cost))
    expect(BigInt(row?.value ?? '0')).toBe(
      (BigInt(balance.on_hand) * BigInt(balance.average_unit_cost) + 500_000n) / 1_000_000n,
    )
  }
  // 150 widgets in Main and 30 in the Annex at 15.00, plus 31 bolts at 5.00.
  expect(valued.totals).toEqual([{ currency: 'BRL', value: '285500' }])
})

it('values a day that has passed as that day left it', async () => {
  const world = await fortnight()

  // The evening of the second delivery: two hundred widgets, no bolts, no annex.
  const valued = await database.valuation(world.tenantId, {
    asOf: '2026-06-03T23:59:59.999Z',
    warehouseId: null,
  })

  expect(valued.rows).toEqual([
    {
      itemId: world.widget,
      warehouseId: world.main,
      quantity: '200',
      unitCost: { amount: '1500', currency: 'BRL' },
      value: '300000',
      currency: 'BRL',
    },
  ])
})

it('tells one shelf its whole story, opening where the story so far left it', async () => {
  const world = await fortnight()

  const whole = await database.kardex(world.tenantId, {
    itemId: world.widget,
    warehouseId: world.main,
    from: '2026-06-01T00:00:00.000Z',
    to: now(),
    limit: 50,
    offset: 0,
  })

  expect(whole.opening).toEqual({ quantity: '0', unitCost: null, value: null })
  expect(whole.lines.map((line) => [line.kind, line.quantity, line.balance])).toEqual([
    ['receipt', '100', '100'],
    ['receipt', '100', '200'],
    ['shipment', '20', '180'],
    ['transfer-out', '30', '150'],
  ])
  expect(whole.closing).toEqual({
    quantity: '150',
    unitCost: { amount: '1500', currency: 'BRL' },
    value: '225000',
  })

  // A window that starts in the middle opens where the earlier window closed, so two
  // pages read end to end tell the same story as one.
  const later = await database.kardex(world.tenantId, {
    itemId: world.widget,
    warehouseId: world.main,
    from: '2026-06-05T00:00:00.000Z',
    to: now(),
    limit: 50,
    offset: 0,
  })
  expect(later.opening).toEqual({
    quantity: '200',
    unitCost: { amount: '1500', currency: 'BRL' },
    value: '300000',
  })
  expect(later.lines).toHaveLength(2)
  expect(later.closing).toEqual(whole.closing)
})

it('says what the goods that were sold had cost, and leaves the rest out of it', async () => {
  const world = await fortnight()

  const sold = await database.costOfGoodsSold(world.tenantId, {
    from: '2026-06-01T00:00:00.000Z',
    to: now(),
    warehouseId: null,
  })

  // Twenty widgets at 15.00 and four bolts at 5.00. The transfer moved thirty more
  // widgets and the breakage took five bolts; neither is the cost of selling anything.
  expect(sold.totals).toEqual([{ currency: 'BRL', value: '32000' }])
  expect(sold.rows.map((row) => [row.quantity, row.value])).toEqual(
    expect.arrayContaining([
      ['20', '30000'],
      ['4', '2000'],
    ]),
  )
})

it('puts the item that carries the period past the threshold in the class it carried it into', async () => {
  const world = await fortnight()

  const curve = await database.abcCurve(world.tenantId, {
    from: '2026-06-01T00:00:00.000Z',
    to: now(),
    warehouseId: null,
    thresholds: { a: 80, b: 95 },
  })

  // Widgets are 93.75% of the period on their own, so they are the whole of class A even
  // though they take the running total past eighty per cent by themselves.
  expect(curve.rows.map((row) => [row.itemId, row.abcClass])).toEqual([
    [world.widget, 'A'],
    [world.bolt, 'B'],
  ])
  expect(curve.rows[0]?.share).toBe('93.7500')
  expect(curve.rows[1]?.cumulativeShare).toBe('100.0000')
})

it('raises the shelf a warehouse is short of, including the one it has none of', async () => {
  const world = await fortnight()
  const levels = new DefineStockLevelUseCase(database, clock)
  const unstocked = randomUUID()
  // 150 widgets free where 200 are wanted; 31 bolts sitting where 10 is the ceiling.
  unwrap(
    await levels.execute({
      context: context(world.tenantId),
      warehouseId: world.main,
      itemId: world.widget,
      minimum: '200',
      maximum: '400',
    }),
  )
  unwrap(
    await levels.execute({
      context: context(world.tenantId),
      warehouseId: world.main,
      itemId: world.bolt,
      minimum: '0',
      maximum: '10',
    }),
  )
  unwrap(
    await levels.execute({
      context: context(world.tenantId),
      warehouseId: world.main,
      itemId: unstocked,
      minimum: '12',
    }),
  )

  const raised = await database.stockAlerts(world.tenantId, {
    warehouseId: null,
    limit: 50,
    offset: 0,
  })

  expect(raised.map((row) => [row.itemId, row.alert, row.suggested, row.excess])).toEqual([
    [world.widget, 'below', '250', null],
    [world.bolt, 'above', null, '21'],
    // Nothing on the shelf is the sharpest shortage there is, and a query over balances
    // alone would never have mentioned it.
    [unstocked, 'below', '12', null],
  ])
})

it('measures short against what is free and over against what is there', async () => {
  const world = await fortnight()
  // Thirty widgets in the annex, all of them promised to an order that has not gone yet.
  at('21')
  const orderId = randomUUID()
  const lineId = randomUUID()
  unwrap(
    await new ReserveStockUseCase(database, clock, 3600).execute({
      tenantId: world.tenantId,
      orderId,
      orderVersion: 1,
      fulfillmentWarehouseId: world.annex,
      lines: [{ lineId, itemId: world.widget, quantity: '30' }],
    }),
  )
  unwrap(
    await new DefineStockLevelUseCase(database, clock).execute({
      context: context(world.tenantId),
      warehouseId: world.annex,
      itemId: world.widget,
      minimum: '10',
      maximum: '20',
    }),
  )

  const position = await database.stockPosition(world.tenantId, {
    warehouseId: world.annex,
    itemId: world.widget,
    limit: 10,
    offset: 0,
  })

  // Nothing is free, so the shelf is short of its ten; it is also over its twenty, but
  // being short is the thing somebody has to act on.
  expect(position[0]).toMatchObject({
    onHand: '30',
    reserved: '30',
    available: '0',
    minimum: '10',
    maximum: '20',
    alert: 'below',
  })
})

it('keeps one tenant’s reports out of another’s', async () => {
  // One after the other, not at once: the fixture winds a clock the whole file shares.
  const ours = await fortnight()
  const theirs = await fortnight()

  const valued = await database.valuation(ours.tenantId, { asOf: now(), warehouseId: null })

  expect(valued.rows.every((row) => row.warehouseId !== theirs.main)).toBe(true)
  expect(valued.totals).toEqual([{ currency: 'BRL', value: '285500' }])
})
