import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ApplyStockReservedUseCase } from '@/application/use-cases/apply-reservation-outcome'
import { ConvertQuoteUseCase } from '@/application/use-cases/convert-quote'
import {
  DecideQuoteUseCase,
  ReviseQuoteUseCase,
  WriteQuoteUseCase,
} from '@/application/use-cases/manage-quotes'
import { PlaceOrderUseCase } from '@/application/use-cases/place-order'
import { ForgetPartyUseCase, ProjectPartyUseCase } from '@/application/use-cases/project-parties'
import {
  DispatchShipmentUseCase,
  PackShipmentUseCase,
  PickShipmentUseCase,
  ReturnShipmentUseCase,
} from '@/application/use-cases/ship-orders'
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

/** Every committing command names who ran it and carries a key it can be retried under. */
function commandOf(tenantId: string, actor = 'ana') {
  return { tenantId, actor, requestId: null, idempotencyKey: randomUUID() }
}

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
    context: commandOf(fixture.tenantId),
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

  const quote = await new WriteQuoteUseCase(database, clock, 15).execute({
    context: commandOf(fixture.tenantId),
    customerId: created.value.customerId,
    quote: {
      lines: [{ lineId: randomUUID(), itemId: fixture.itemId, quantity: '2.5' }],
      terms: { freight: '500', paymentTermDays: [0, 30] },
    },
  })
  if (quote.isLeft()) throw quote.value
  const decide = new DecideQuoteUseCase(database, clock)
  const decision = commandOf(fixture.tenantId)
  expect((await decide.send(decision, quote.value.quoteId)).isRight()).toBe(true)
  const accepted = await decide.accept(decision, quote.value.quoteId)
  expect(accepted.isRight()).toBe(true)
  const [persistedQuote] = await administrator`select status, net, total, currency, version,
      root_id, payment_term_days from quotes where id = ${quote.value.quoteId}`
  // The goods are 3125 and the freight is 500: an offer totals what it charges.
  expect(persistedQuote).toEqual({
    status: 'accepted',
    net: '3125',
    total: '3625',
    currency: 'BRL',
    version: 1,
    root_id: quote.value.quoteId,
    payment_term_days: [0, 30],
  })

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

it('negotiates an offer in versions and makes the accepted one binding', async () => {
  const fixture = await seedCatalogItem()
  const tenantId = fixture.tenantId
  const customerId = randomUUID()
  const projected = await database.inTenant(tenantId, (scope) =>
    new ProjectPartyUseCase(clock).executeInScope(scope, {
      tenantId,
      partyId: customerId,
      legalName: 'Maria Silva',
      email: 'maria@example.com',
      phone: '+55 11 99999-9999',
      address: 'Rua Um, 42, São Paulo',
      roles: ['customer'],
      active: true,
    }),
  )
  if (projected.isLeft()) throw projected.value

  const lineId = randomUUID()
  const first = await new WriteQuoteUseCase(database, clock, 15).execute({
    context: commandOf(tenantId),
    customerId,
    quote: {
      lines: [{ lineId, itemId: fixture.itemId, quantity: '2' }],
      terms: { freight: '500', paymentTermDays: [0, 30] },
    },
  })
  if (first.isLeft()) throw first.value
  const decide = new DecideQuoteUseCase(database, clock)
  expect((await decide.send(commandOf(tenantId), first.value.quoteId)).isRight()).toBe(true)

  // The customer haggles. What they were shown is kept; a new version stands beside it.
  const second = await new ReviseQuoteUseCase(database, clock, 15).execute({
    context: commandOf(tenantId),
    quoteId: first.value.quoteId,
    quote: {
      lines: [{ lineId, itemId: fixture.itemId, quantity: '2' }],
      terms: { freight: '500', discount: '250', paymentTermDays: [0, 30] },
    },
  })
  if (second.isLeft()) throw second.value
  expect(second.value.version).toBe(2)
  const versions = await administrator`select id, version, status, superseded_by, supersedes,
      root_id, total from quotes where tenant_id = ${tenantId} order by version`
  expect(versions).toMatchObject([
    { version: 1, status: 'superseded', superseded_by: second.value.quoteId, total: '3000' },
    { version: 2, status: 'draft', supersedes: first.value.quoteId, total: '2750' },
  ])
  expect(versions.every((row) => row.root_id === first.value.quoteId)).toBe(true)

  expect((await decide.send(commandOf(tenantId), second.value.quoteId)).isRight()).toBe(true)
  expect((await decide.accept(commandOf(tenantId), second.value.quoteId)).isRight()).toBe(true)

  const convert = new ConvertQuoteUseCase(database, clock)
  const conversion = {
    context: commandOf(tenantId),
    quoteId: second.value.quoteId,
    fulfillmentWarehouseId: randomUUID(),
  }
  const converted = await convert.execute(conversion)
  if (converted.isLeft()) throw converted.value
  // A retried command answers with the order it already made, and makes no second one.
  const retried = await convert.execute(conversion)
  if (retried.isLeft()) throw retried.value
  expect(retried.value).toEqual(converted.value)

  const orders = await administrator`select id, quote_id, discount, freight, payment_term_days,
      status from sales_orders where tenant_id = ${tenantId}`
  expect(orders).toMatchObject([
    {
      id: converted.value.orderId,
      quote_id: second.value.quoteId,
      discount: '250',
      freight: '500',
      payment_term_days: [0, 30],
      status: 'placed',
    },
  ])

  // The catalogue moves between the yes and the reservation. The agreement does not.
  await administrator`update catalog_items set unit_price = 9999
    where tenant_id = ${tenantId} and item_id = ${fixture.itemId}`
  const confirmed = await new ApplyStockReservedUseCase(database, clock).execute({
    tenantId,
    orderId: converted.value.orderId,
    orderVersion: 1,
    reservationId: randomUUID(),
  })
  expect(confirmed.isRight()).toBe(true)
  const [order] = await administrator`select status, total from sales_orders
    where id = ${converted.value.orderId}`
  // Two at 1250, plus 500 of freight, less the 250 that was agreed off.
  expect(order).toMatchObject({ status: 'confirmed', total: '2750' })

  const [event] = await administrator`select payload from outbox
    where tenant_id = ${tenantId} and event_type = 'sales.order.confirmed'`
  expect(event?.payload).toMatchObject({
    installments: [
      { number: 1, amount: { amount: '1375', currency: 'BRL' } },
      { number: 2, amount: { amount: '1375', currency: 'BRL' } },
    ],
  })

  // Every decision is in the tenant's chain, in the order it was taken.
  const trail = await administrator`select sequence, actor, action, subject_type, previous_hash
    from audit_log where tenant_id = ${tenantId} order by sequence`
  expect(trail.map((row) => row.action)).toEqual([
    'quote.written',
    'quote.send',
    'quote.versioned',
    'quote.send',
    'quote.accept',
    'order.placed',
    'quote.converted',
  ])
  expect(trail[0]?.previous_hash).toBe('0'.repeat(64))
  expect(trail.every((row) => row.actor === 'ana')).toBe(true)
})

it('delivers an order in parts, and takes one delivery back', async () => {
  const fixture = await seedCatalogItem()
  const tenantId = fixture.tenantId
  const lineId = randomUUID()
  const placed = await new PlaceOrderUseCase(database, clock).execute({
    context: commandOf(tenantId),
    customerId: randomUUID(),
    fulfillmentWarehouseId: randomUUID(),
    terms: { freight: '500', paymentTermDays: [30] },
    lines: [{ lineId, itemId: fixture.itemId, quantity: '10' }],
  })
  if (placed.isLeft()) throw placed.value
  const orderId = placed.value.orderId
  const confirmed = await new ApplyStockReservedUseCase(database, clock).execute({
    tenantId,
    orderId,
    orderVersion: 1,
    reservationId: randomUUID(),
  })
  expect(confirmed.isRight()).toBe(true)
  // Ten at 1250 plus 500 of freight: 13000 charged for the order as a whole.
  const [order] = await administrator`select total, fulfillment from sales_orders
    where id = ${orderId}`
  expect(order).toMatchObject({ total: '13000', fulfillment: 'unfulfilled' })

  const ship = async (quantity: string) => {
    const picked = await new PickShipmentUseCase(database, clock).execute({
      context: commandOf(tenantId),
      orderId,
      lines: [{ lineId, quantity }],
    })
    if (picked.isLeft()) throw picked.value
    const packed = await new PackShipmentUseCase(database, clock).execute({
      context: commandOf(tenantId),
      shipmentId: picked.value.shipmentId,
      consignment: { carrier: 'Correios', trackingCode: `BR-${quantity}` },
    })
    if (packed.isLeft()) throw packed.value
    const dispatched = await new DispatchShipmentUseCase(database, clock).execute({
      context: commandOf(tenantId),
      shipmentId: picked.value.shipmentId,
      dispatchedOn: '2026-09-20',
    })
    if (dispatched.isLeft()) throw dispatched.value
    return dispatched.value
  }

  const first = await ship('4')
  // Four of ten units of an order charged 13000: 5200 goes, 7800 is still expected.
  expect(first).toMatchObject({ value: '5200', remaining: '7800', complete: false })
  const second = await ship('6')
  expect(second).toMatchObject({ value: '7800', remaining: '0', complete: true })

  const [delivered] = await administrator`select fulfillment, shipments from sales_orders
    where id = ${orderId}`
  expect(delivered).toEqual({ fulfillment: 'fulfilled', shipments: 2 })
  const shipmentRows = await administrator`select status, value, carrier, tracking_code,
      dispatched_on from shipments where tenant_id = ${tenantId} order by created_at`
  expect(shipmentRows).toMatchObject([
    { status: 'dispatched', value: '5200', carrier: 'Correios', tracking_code: 'BR-4' },
    { status: 'dispatched', value: '7800', tracking_code: 'BR-6' },
  ])

  // The warehouse's board is not one order's history: unscoped, the newest work is first.
  const board = await database.listShipmentSnapshots(tenantId)
  expect(board.map((shipment) => shipment.value.amount)).toEqual(['7800', '5200'])
  const ofOrder = await database.listShipmentSnapshots(tenantId, orderId)
  expect(ofOrder.map((shipment) => shipment.value.amount)).toEqual(['5200', '7800'])

  // The lines of a delivery that has left are a record of a physical event.
  await expect(
    administrator`update shipment_lines set quantity = 1
      where shipment_id = ${first.shipmentId}`,
  ).rejects.toThrow(/cannot change once the goods have left/)

  const returned = await new ReturnShipmentUseCase(database, clock).execute({
    context: commandOf(tenantId),
    shipmentId: first.shipmentId,
    reason: 'Damaged in transit',
    returnedOn: '2026-09-25',
  })
  if (returned.isLeft()) throw returned.value
  expect(returned.value).toMatchObject({ value: '5200', remaining: '5200' })
  const [afterReturn] = await administrator`select fulfillment, shipments from sales_orders
    where id = ${orderId}`
  expect(afterReturn).toEqual({ fulfillment: 'partial', shipments: 1 })
  // Those four units are owed to the customer again, so they can be shipped again.
  const [line] = await administrator`select quantity, shipped, allocated from sales_order_lines
    where order_id = ${orderId}`
  expect(line).toEqual({ quantity: '10000000', shipped: '6000000', allocated: '0' })

  // Ordered by id as well: events published in one transaction share its timestamp.
  const outbox = await administrator`select event_type from outbox
    where tenant_id = ${tenantId} order by created_at, id`
  expect(outbox.map((row) => row.event_type)).toEqual([
    'sales.order.placed',
    'sales.order.confirmed',
    'sales.shipment.dispatched',
    'sales.invoicing.requested',
    'sales.shipment.dispatched',
    'sales.invoicing.requested',
    'sales.shipment.returned',
  ])
})
