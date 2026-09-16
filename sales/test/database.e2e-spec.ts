import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ApplyStockReservedUseCase } from '@/application/use-cases/apply-reservation-outcome'
import { AcceptQuoteUseCase, CreateQuoteUseCase } from '@/application/use-cases/manage-quotes'
import { PlaceOrderUseCase } from '@/application/use-cases/place-order'
import { ForgetPartyUseCase, ProjectPartyUseCase } from '@/application/use-cases/project-parties'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { SalesDatabase } from '@/infrastructure/database/drizzle/sales-database'

const clock = { now: () => new Date() }
let database: SalesDatabase
let application: ReturnType<typeof postgres>
let administrator: ReturnType<typeof postgres>

beforeAll(() => {
  database = new SalesDatabase({
    url: process.env.DATABASE_URL ?? '',
    customerPrivacy: {
      secretBox: new AesGcmSecretBox(),
      blindIndexKey: randomBytes(32),
    },
  })
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), application?.end(), administrator?.end()])
})

async function seedCatalogItem() {
  const tenantId = randomUUID()
  const itemId = randomUUID()
  await database.provisionTenant(tenantId)
  await administrator`insert into catalog_items
    (tenant_id, item_id, description, unit_price, currency, active, updated_at)
    values (${tenantId}, ${itemId}, 'Roasted coffee', 1250, 'BRL', 1, now())`
  return { tenantId, itemId }
}

async function placeOrder(fixture: { tenantId: string; itemId: string }) {
  const result = await new PlaceOrderUseCase(database, clock).execute({
    tenantId: fixture.tenantId,
    customerId: randomUUID(),
    fulfillmentWarehouseId: randomUUID(),
    lines: [{ lineId: randomUUID(), itemId: fixture.itemId, quantity: '2.5' }],
  })
  if (result.isLeft()) throw result.value
  return result.value.orderId
}

it('persists the order and immutable commercial snapshot with its outbox events', async () => {
  const fixture = await seedCatalogItem()
  const orderId = await placeOrder(fixture)
  const reservationId = randomUUID()
  const confirmed = await new ApplyStockReservedUseCase(database, clock).execute({
    tenantId: fixture.tenantId,
    orderId,
    orderVersion: 1,
    reservationId,
  })
  expect(confirmed.isRight()).toBe(true)

  const [order] = await administrator`select status, version, reservation_id, total, currency
    from sales_orders where id = ${orderId}`
  expect(order).toEqual({
    status: 'confirmed',
    version: 2,
    reservation_id: reservationId,
    total: '3125',
    currency: 'BRL',
  })
  const [line] = await administrator`select quantity, description, unit_price, line_total, currency
    from sales_order_lines where order_id = ${orderId}`
  expect(line).toEqual({
    quantity: '2500000',
    description: 'Roasted coffee',
    unit_price: '1250',
    line_total: '3125',
    currency: 'BRL',
  })
  const events = await administrator`select event_type, payload from outbox
    where tenant_id = ${fixture.tenantId} order by created_at`
  expect(events.map((event) => event.event_type)).toEqual([
    'sales.order.placed',
    'sales.order.confirmed',
    'sales.invoicing.requested',
  ])
  expect(events[1]?.payload).toMatchObject({ orderId, orderVersion: 2, reservationId })
})

it('serializes competing reservation outcomes and rejects the stale transition', async () => {
  const fixture = await seedCatalogItem()
  const orderId = await placeOrder(fixture)
  const apply = (reservationId: string) =>
    new ApplyStockReservedUseCase(database, clock).execute({
      tenantId: fixture.tenantId,
      orderId,
      orderVersion: 1,
      reservationId,
    })
  const outcomes = await Promise.all([apply(randomUUID()), apply(randomUUID())])
  expect(outcomes.filter((outcome) => outcome.isRight())).toHaveLength(1)
  expect(outcomes.filter((outcome) => outcome.isLeft())).toHaveLength(1)
  const [order] =
    await administrator`select status, version from sales_orders where id = ${orderId}`
  expect(order).toEqual({ status: 'confirmed', version: 2 })
})

it('enforces cross-tenant isolation and resets pooled tenant context', async () => {
  const a = await seedCatalogItem()
  const b = await seedCatalogItem()
  const orderId = await placeOrder(a)
  await database.inTenant(a.tenantId, async (scope) => {
    expect(await scope.orders.findById(orderId)).not.toBeNull()
  })
  await database.inTenant(b.tenantId, async (scope) => {
    expect(await scope.orders.findById(orderId)).toBeNull()
    expect(await scope.catalogItems.findById(a.itemId)).toBeNull()
  })
  await application.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${b.tenantId}, true)`
    const rows = await tx`select * from sales_orders where id = ${orderId}`
    expect(rows).toHaveLength(0)
    const changed = await tx`update sales_orders set status = 'cancelled' where id = ${orderId}`
    expect(changed.count).toBe(0)
  })
})

it('rolls back order changes and inbox claims when work fails', async () => {
  const fixture = await seedCatalogItem()
  const orderId = await placeOrder(fixture)
  await expect(
    database.inTenant(fixture.tenantId, async (scope) => {
      const order = await scope.orders.findById(orderId)
      if (!order) throw new Error('fixture missing')
      const rejected = order.rejectReservation(1, new Date())
      if (rejected.isLeft()) throw rejected.value
      await scope.orders.save(order)
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  const [order] =
    await administrator`select status, version from sales_orders where id = ${orderId}`
  expect(order).toEqual({ status: 'placed', version: 1 })

  const event = {
    sourceModule: 'inventory',
    eventId: randomUUID(),
    eventType: 'inventory.stock.reserved',
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
  const fixture = await seedCatalogItem()
  const event = {
    sourceModule: 'inventory',
    eventId: randomUUID(),
    eventType: 'inventory.stock.reserved',
  }
  const first = await database.processEvent(fixture.tenantId, event, async () => 'confirmed')
  const duplicate = await database.processEvent(fixture.tenantId, event, async () => 'duplicate')
  expect(first).toEqual({ processed: true, value: 'confirmed' })
  expect(duplicate).toEqual({ processed: false })
  const claims = await administrator`select * from inbox where event_id = ${event.eventId}`
  expect(claims).toHaveLength(1)
})

it('uses an RLS-bound application role and protects relay-owned outbox state', async () => {
  const [role] =
    await administrator`select rolsuper, rolbypassrls from pg_roles where rolname = 'horizon_app'`
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false })
  const [privileges] = await application`select
    has_table_privilege(current_user, 'sales_orders', 'DELETE') as order_delete,
    has_table_privilege(current_user, 'outbox', 'UPDATE') as outbox_update`
  expect(privileges).toEqual({ order_delete: false, outbox_update: false })
})

it('persists priced quotes and crypto-shreds customer personal data', async () => {
  const fixture = await seedCatalogItem()
  const partyId = randomUUID()
  const projected = await database.inTenant(fixture.tenantId, (scope) =>
    new ProjectPartyUseCase(clock).executeInScope(scope, {
      tenantId: fixture.tenantId,
      partyId,
      legalName: 'Maria Silva',
      email: 'maria@example.com',
      phone: '+55 11 99999-9999',
      address: 'Rua Um, 42, São Paulo',
      roles: ['customer'],
      active: true,
    }),
  )
  if (projected.isLeft()) throw projected.value
  const created = { value: { customerId: partyId } }
  const [stored] =
    await administrator`select * from customers where id = ${created.value.customerId}`
  expect(stored?.name_ciphertext).not.toContain('Maria')
  expect(stored?.email_ciphertext).not.toContain('maria@example.com')
  // The registry owns the tax identifier; the projection never receives it.
  expect(stored?.tax_id_ciphertext).toBeNull()

  const quote = await new CreateQuoteUseCase(database, clock, 15).execute({
    tenantId: fixture.tenantId,
    customerId: created.value.customerId,
    lines: [{ lineId: randomUUID(), itemId: fixture.itemId, quantity: '2.5' }],
  })
  if (quote.isLeft()) throw quote.value
  const accepted = await new AcceptQuoteUseCase(database, clock).execute({
    tenantId: fixture.tenantId,
    quoteId: quote.value.quoteId,
  })
  expect(accepted.isRight()).toBe(true)
  const [persistedQuote] = await administrator`select status, total, currency from quotes
    where id = ${quote.value.quoteId}`
  expect(persistedQuote).toEqual({ status: 'accepted', total: '3125', currency: 'BRL' })

  const erased = await database.inTenant(fixture.tenantId, (scope) =>
    new ForgetPartyUseCase(clock).executeInScope(scope, created.value.customerId),
  )
  expect(erased).toBe(true)
  const [key] = await administrator`select material, erased_at from customer_data_keys
    where id = ${created.value.customerId}`
  expect(key?.material).toBeNull()
  expect(key?.erased_at).toBeInstanceOf(Date)
  const [after] = await administrator`select status, name_ciphertext, email_ciphertext
    from customers where id = ${created.value.customerId}`
  expect(after).toMatchObject({
    status: 'erased',
    name_ciphertext: stored?.name_ciphertext,
    email_ciphertext: stored?.email_ciphertext,
  })
  await database.inTenant(fixture.tenantId, async (scope) => {
    expect((await scope.customers.findById(created.value.customerId))?.isActive()).toBe(false)
  })
})
