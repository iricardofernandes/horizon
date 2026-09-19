import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ConfirmReservationUseCase } from '@/application/use-cases/confirm-reservation'
import { ReserveStockUseCase } from '@/application/use-cases/reserve-stock'
import {
  ReturnToStockUseCase,
  ShipReservationUseCase,
} from '@/application/use-cases/ship-reservation'
import { Quantity } from '@/domain/value-objects/inventory-values'
import { InventoryDatabase } from '@/infrastructure/database/drizzle/inventory-database'

const clock = { now: () => new Date() }
let database: InventoryDatabase
let application: ReturnType<typeof postgres>
let administrator: ReturnType<typeof postgres>

beforeAll(() => {
  database = new InventoryDatabase({ url: process.env.DATABASE_URL ?? '' })
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), application?.end(), administrator?.end()])
})

async function seedBalance(onHand = 10_000_000n) {
  const tenantId = randomUUID()
  const warehouseId = randomUUID()
  const itemId = randomUUID()
  const balanceId = randomUUID()
  await database.provisionTenant(tenantId)
  await administrator`insert into warehouses (id, tenant_id, name, created_at, updated_at)
    values (${warehouseId}, ${tenantId}, 'Main warehouse', now(), now())`
  await administrator`insert into stock_balances
    (id, tenant_id, item_id, warehouse_id, on_hand, reserved, average_unit_cost, currency, version, updated_at)
    values (${balanceId}, ${tenantId}, ${itemId}, ${warehouseId}, ${onHand.toString()}, 0, 1250, 'BRL', 0, now())`
  return { tenantId, warehouseId, itemId, balanceId }
}

it('persists reservations, shipments, movements and outbox events atomically', async () => {
  const fixture = await seedBalance()
  const orderId = randomUUID()
  const lineId = randomUUID()
  const reserved = await new ReserveStockUseCase(database, clock, 900).execute({
    ...fixture,
    orderId,
    orderVersion: 1,
    fulfillmentWarehouseId: fixture.warehouseId,
    lines: [{ lineId, itemId: fixture.itemId, quantity: '3' }],
  })
  if (reserved.isLeft()) throw reserved.value
  expect(reserved.value.reserved).toBe(true)
  if (!reserved.value.reserved) throw new Error('expected reservation')

  const confirmed = await new ConfirmReservationUseCase(database, clock).execute({
    tenantId: fixture.tenantId,
    orderId,
    orderVersion: 2,
    reservationId: reserved.value.reservationId,
  })
  expect(confirmed.isRight()).toBe(true)

  // Committing the order holds the goods; nothing has left the warehouse yet.
  const [held] = await administrator`select on_hand, reserved, version from stock_balances
    where id = ${fixture.balanceId}`
  expect(held).toEqual({ on_hand: '10000000', reserved: '3000000', version: 0 })
  const [reservation] = await administrator`select status, order_version from stock_reservations
    where order_id = ${orderId}`
  expect(reservation).toEqual({ status: 'confirmed', order_version: 2 })

  // Two units go, then the last one: each delivery takes its own stock out.
  const ship = (quantity: string) =>
    database.inTenant(fixture.tenantId, (scope) =>
      new ShipReservationUseCase(clock).executeInScope(scope, {
        tenantId: fixture.tenantId,
        orderId,
        lines: [{ lineId, quantity }],
      }),
    )
  expect((await ship('2')).isRight()).toBe(true)
  const [partly] = await administrator`select on_hand, reserved from stock_balances
    where id = ${fixture.balanceId}`
  expect(partly).toEqual({ on_hand: '8000000', reserved: '1000000' })
  expect(
    (await administrator`select status from stock_reservations where order_id = ${orderId}`)[0],
  ).toEqual({ status: 'confirmed' })
  expect((await ship('1')).isRight()).toBe(true)
  const [gone] = await administrator`select on_hand, reserved from stock_balances
    where id = ${fixture.balanceId}`
  expect(gone).toEqual({ on_hand: '7000000', reserved: '0' })
  expect(
    (await administrator`select status from stock_reservations where order_id = ${orderId}`)[0],
  ).toEqual({ status: 'shipped' })

  // The customer sends one back: it returns to the shelf, and to its promise.
  const returned = await database.inTenant(fixture.tenantId, (scope) =>
    new ReturnToStockUseCase(clock).executeInScope(scope, {
      tenantId: fixture.tenantId,
      orderId,
      lines: [{ lineId, quantity: '1' }],
    }),
  )
  expect(returned.isRight()).toBe(true)
  const [back] = await administrator`select on_hand, reserved from stock_balances
    where id = ${fixture.balanceId}`
  expect(back).toEqual({ on_hand: '8000000', reserved: '1000000' })

  const movements = await administrator`select kind, quantity, balance_after
    from stock_movements where balance_id = ${fixture.balanceId} order by balance_version`
  expect(movements).toEqual([
    { kind: 'shipment', quantity: '2000000', balance_after: '8000000' },
    { kind: 'shipment', quantity: '1000000', balance_after: '7000000' },
    { kind: 'return-in', quantity: '1000000', balance_after: '8000000' },
  ])
  const outbox = await administrator`select event_type from outbox
    where tenant_id = ${fixture.tenantId} order by created_at`
  expect(outbox.map((row) => row.event_type)).toEqual([
    'inventory.stock.reserved',
    'inventory.stock.moved',
    'inventory.stock.moved',
    'inventory.stock.moved',
  ])
})

it('serializes competing reservations with a row lock', async () => {
  const fixture = await seedBalance()
  const reserve = (orderId: string) =>
    new ReserveStockUseCase(database, clock, 900).execute({
      tenantId: fixture.tenantId,
      orderId,
      orderVersion: 1,
      fulfillmentWarehouseId: fixture.warehouseId,
      lines: [{ lineId: randomUUID(), itemId: fixture.itemId, quantity: '8' }],
    })
  const outcomes = await Promise.all([reserve(randomUUID()), reserve(randomUUID())])
  const values = outcomes.map((outcome) => {
    if (outcome.isLeft()) throw outcome.value
    return outcome.value
  })
  expect(values.filter((value) => value.reserved)).toHaveLength(1)
  expect(values.filter((value) => !value.reserved)).toHaveLength(1)
  const [balance] = await administrator`select reserved from stock_balances
    where id = ${fixture.balanceId}`
  expect(balance?.reserved).toBe('8000000')
})

it('enforces cross-tenant isolation and resets pooled tenant context', async () => {
  const a = await seedBalance()
  const b = await seedBalance()
  await database.inTenant(a.tenantId, async (scope) => {
    expect(await scope.balances.lock(a.itemId, a.warehouseId)).not.toBeNull()
  })
  await database.inTenant(b.tenantId, async (scope) => {
    expect(await scope.balances.lock(a.itemId, a.warehouseId)).toBeNull()
  })
  await application.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${b.tenantId}, true)`
    const rows = await tx`select * from stock_balances where id = ${a.balanceId}`
    expect(rows).toHaveLength(0)
    const changed = await tx`update stock_balances set reserved = 1 where id = ${a.balanceId}`
    expect(changed.count).toBe(0)
  })
})

it('rolls back domain state, inbox claims and effects when work fails', async () => {
  const fixture = await seedBalance()
  await expect(
    database.inTenant(fixture.tenantId, async (scope) => {
      const balance = await scope.balances.lock(fixture.itemId, fixture.warehouseId)
      if (!balance) throw new Error('fixture missing')
      const held = balance.hold(Quantity.fromMicros(2_000_000n), new Date())
      if (held.isLeft()) throw held.value
      await scope.balances.save(balance)
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  const [balance] = await administrator`select reserved from stock_balances
    where id = ${fixture.balanceId}`
  expect(balance?.reserved).toBe('0')

  const event = {
    sourceModule: 'sales',
    eventId: randomUUID(),
    eventType: 'sales.order.placed',
  }
  await expect(
    database.processEvent(fixture.tenantId, event, async () => {
      throw new Error('handler failed')
    }),
  ).rejects.toThrow('handler failed')
  const claims = await administrator`select * from inbox where event_id = ${event.eventId}`
  expect(claims).toHaveLength(0)
})

it('deduplicates consumed events in the same transaction as their effect', async () => {
  const fixture = await seedBalance()
  const event = {
    sourceModule: 'sales',
    eventId: randomUUID(),
    eventType: 'sales.order.placed',
  }
  const first = await database.processEvent(fixture.tenantId, event, async () => 'reserved')
  const duplicate = await database.processEvent(fixture.tenantId, event, async () => 'duplicate')
  expect(first).toEqual({ processed: true, value: 'reserved' })
  expect(duplicate).toEqual({ processed: false })
  const claims = await administrator`select * from inbox where event_id = ${event.eventId}`
  expect(claims).toHaveLength(1)
})

it('uses unprivileged roles and keeps movement history append-only', async () => {
  const [role] =
    await administrator`select rolsuper, rolbypassrls from pg_roles where rolname = 'horizon_app'`
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false })
  const [privileges] = await application`select
    has_table_privilege(current_user, 'stock_movements', 'UPDATE') as movement_update,
    has_table_privilege(current_user, 'stock_movements', 'DELETE') as movement_delete,
    has_table_privilege(current_user, 'outbox', 'UPDATE') as outbox_update`
  expect(privileges).toEqual({
    movement_update: false,
    movement_delete: false,
    outbox_update: false,
  })
  await expect(administrator`truncate stock_movements`).rejects.toThrow('append-only')
})
