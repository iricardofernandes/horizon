import { randomBytes, randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { salesFiscalOriginRecorded } from '@horizon/contracts'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { SalesModuleEventHandlers } from '@/application/consume-module-events'
import { ApplyStockReservedUseCase } from '@/application/use-cases/apply-reservation-outcome'
import {
  BillPeriodUseCase,
  CreditPeriodUseCase,
  ProcessBillingRunUseCase,
  StartBillingRunUseCase,
} from '@/application/use-cases/contract-billing'
import { ConvertQuoteUseCase } from '@/application/use-cases/convert-quote'
import {
  DecideQuoteUseCase,
  ReviseQuoteUseCase,
  WriteQuoteUseCase,
} from '@/application/use-cases/manage-quotes'
import { PlaceOrderUseCase } from '@/application/use-cases/place-order'
import { ForgetPartyUseCase, ProjectPartyUseCase } from '@/application/use-cases/project-parties'
import {
  AmendContractUseCase,
  CreateContractUseCase,
  DecideContractUseCase,
  RenewContractUseCase,
  RenewDueContractsUseCase,
} from '@/application/use-cases/service-contracts'
import {
  DecideServiceOrderUseCase,
  DeliverServiceUseCase,
  OpenServiceOrderUseCase,
} from '@/application/use-cases/service-orders'
import {
  DispatchShipmentUseCase,
  PackShipmentUseCase,
  PickShipmentUseCase,
  ReturnShipmentUseCase,
} from '@/application/use-cases/ship-orders'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { Customer } from '@/domain/entities/customer'
import {
  type BusinessDate,
  CustomerEmail,
  CustomerName,
  CustomerPhone,
  TaxId,
} from '@/domain/value-objects/sales-values'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { SalesDatabase } from '@/infrastructure/database/drizzle/sales-database'
import { BillingGauges } from '@/infrastructure/observability/billing-metrics'
import { e2ePostgresContainer } from './setup-e2e'

const clock = { now: () => new Date() }

/**
 * Dated against the clock the suite runs on, not the calendar it was written on.
 *
 * The orders below are issued today, and goods cannot leave before the order that sent
 * them — so a date written into the source is a test that passes until the morning it
 * quietly stops being today.
 */
const today = () => clock.now().toISOString().slice(0, 10)
const daysFromToday = (days: number) => {
  const day = clock.now()
  day.setUTCDate(day.getUTCDate() + days)
  return day.toISOString().slice(0, 10)
}
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

it('sums orders by status and currency for reporting to reconcile against', async () => {
  const fixture = await seedCatalogItem()
  const confirmedId = await placeOrder(fixture)
  await new ApplyStockReservedUseCase(database, clock).execute({
    tenantId: fixture.tenantId,
    orderId: confirmedId,
    orderVersion: 1,
    reservationId: randomUUID(),
  })
  await placeOrder(fixture)
  expect(await database.ordersSummary(fixture.tenantId)).toEqual({
    data: [
      { status: 'confirmed', currency: 'BRL', count: 1, total: '3125' },
      // A placed order is priced when Inventory confirms it.
      { status: 'placed', currency: 'BRL', count: 1, total: '0' },
    ],
  })
  expect(await database.ordersSummary(randomUUID())).toEqual({ data: [] })
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

it('round-trips numeric and alphanumeric CNPJ in existing Sales customer rows', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const value = <E, T>(result: Either<E, T>): T => {
    if (result.isLeft()) throw result.value
    return result.value
  }
  for (const input of ['12.345.678/0001-95', '00.000.000/e08g-12']) {
    const id = randomUUID()
    const now = new Date()
    const customer = Customer.rehydrate(
      {
        tenantId,
        name: value(CustomerName.create(`Legacy ${id}`)),
        email: value(CustomerEmail.create(`${id}@example.com`)),
        phone: value(CustomerPhone.create('+55 11 99999-9999')),
        address: 'Rua Um, 42',
        taxId: value(TaxId.create(input)),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      new UniqueEntityID(id),
    )
    await database.inTenant(tenantId, (scope) => scope.customers.create(customer))
    const restored = await database.inTenant(tenantId, (scope) => scope.customers.findById(id))
    expect(restored?.toSnapshot().taxId).toBe(input.replace(/[^\dA-Za-z]/g, '').toUpperCase())
    const [stored] = await administrator`select tax_id_ciphertext from customers where id = ${id}`
    expect(stored?.tax_id_ciphertext).not.toContain('E08G')
  }
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
  const orderId = converted.value.orderId
  if (!orderId) throw new Error('the goods of the proposal became no order')

  const orders = await administrator`select id, quote_id, discount, freight, payment_term_days,
      status from sales_orders where tenant_id = ${tenantId}`
  expect(orders).toMatchObject([
    {
      id: orderId,
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
    orderId,
    orderVersion: 1,
    reservationId: randomUUID(),
  })
  expect(confirmed.isRight()).toBe(true)
  const [order] = await administrator`select status, total from sales_orders
    where id = ${orderId}`
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
      dispatchedOn: today(),
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
    returnedOn: daysFromToday(5),
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
    'sales.fiscal-origin.recorded',
    'sales.shipment.dispatched',
    'sales.invoicing.requested',
    'sales.fiscal-origin.recorded',
    'sales.shipment.returned',
    'sales.fiscal-origin.recorded',
  ])
  const origins =
    await administrator`select document_id, purpose from fiscal_origins where tenant_id = ${tenantId}`
  expect(origins).toHaveLength(3)
  expect(origins.filter((origin) => origin.purpose === 'original')).toHaveLength(2)
  expect(origins.filter((origin) => origin.purpose === 'return')).toHaveLength(1)
  const fiscalEvents = await administrator`select payload from outbox
    where tenant_id = ${tenantId} and event_type = 'sales.fiscal-origin.recorded'`
  const payloads = fiscalEvents.map((event) =>
    salesFiscalOriginRecorded.payload.parse(event.payload),
  )
  expect(payloads).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ originId: first.shipmentId, purpose: 'original', orderId }),
      expect.objectContaining({ originId: second.shipmentId, purpose: 'original', orderId }),
      expect.objectContaining({ originId: first.shipmentId, purpose: 'return', orderId }),
    ]),
  )
})

it('blocks a scoped dispatch in PostgreSQL until its exact production release', async () => {
  const fixture = await seedCatalogItem()
  const orderId = await placeOrder(fixture)
  const confirmed = await new ApplyStockReservedUseCase(database, clock).execute({
    tenantId: fixture.tenantId,
    orderId,
    orderVersion: 1,
    reservationId: randomUUID(),
  })
  expect(confirmed.isRight()).toBe(true)
  const [line] =
    await administrator`select line_id from sales_order_lines where order_id = ${orderId}`
  if (!line) throw new Error('missing order line')
  const picked = await new PickShipmentUseCase(database, clock).execute({
    context: commandOf(fixture.tenantId),
    orderId,
    lines: [{ lineId: String(line.line_id), quantity: '1' }],
  })
  if (picked.isLeft()) throw picked.value
  const shipmentId = picked.value.shipmentId
  const [shipment] =
    await administrator`select warehouse_id from shipments where id = ${shipmentId}`
  const [order] = await administrator`select version from sales_orders where id = ${orderId}`
  if (!shipment || !order) throw new Error('missing dispatch fixture')
  const warehouseId = String(shipment.warehouse_id)
  const orderVersion = Number(order.version)
  const establishmentId = randomUUID()
  await administrator`insert into sales_fiscal_dispatch_policies
    (tenant_id, warehouse_id, establishment_id, reason, created_by)
    values (${fixture.tenantId}, ${warehouseId}, ${establishmentId},
      'Phase 43 isolated fiscal dispatch gate', 'phase43-e2e')`
  const packed = await new PackShipmentUseCase(database, clock).execute({
    context: commandOf(fixture.tenantId),
    shipmentId,
  })
  if (packed.isLeft()) throw packed.value
  const [frozen] = await administrator`select payload_digest, establishment_id, warehouse_id
    from sales_fiscal_origin_freezes where tenant_id = ${fixture.tenantId}
      and shipment_id = ${shipmentId}`
  expect(frozen).toMatchObject({ establishment_id: establishmentId, warehouse_id: warehouseId })
  const [originEvent] = await administrator`select event_version from outbox
    where tenant_id = ${fixture.tenantId} and event_type = 'sales.fiscal-origin.recorded'`
  expect(originEvent?.event_version).toBe(2)
  await expect(administrator`update shipments set warehouse_id = ${randomUUID()}
    where tenant_id = ${fixture.tenantId} and id = ${shipmentId}`).rejects.toThrow(
    'fiscal origin is frozen',
  )
  await expect(administrator`update shipments
    set warehouse_id = ${randomUUID()}, status = 'dispatched',
      dispatched_by = 'direct-sql', dispatched_on = ${today()}
    where tenant_id = ${fixture.tenantId} and id = ${shipmentId}`).rejects.toThrow(
    'fiscal origin is frozen',
  )
  await expect(administrator`update shipments set value = value + 1
    where tenant_id = ${fixture.tenantId} and id = ${shipmentId}`).rejects.toThrow(
    'fiscal origin is frozen',
  )
  await expect(administrator`delete from shipment_lines
    where tenant_id = ${fixture.tenantId} and shipment_id = ${shipmentId}`).rejects.toThrow(
    'lines are frozen for fiscal origin',
  )
  const dispatch = () =>
    new DispatchShipmentUseCase(database, clock).execute({
      context: commandOf(fixture.tenantId),
      shipmentId,
      dispatchedOn: today(),
    })
  expect((await dispatch()).isLeft()).toBe(true)
  await verifyRestoredFiscalGate(fixture.tenantId, shipmentId)
  await expect(administrator`insert into shipments (
    id, tenant_id, order_id, warehouse_id, status, value, currency,
    picked_by, packed_by, dispatched_by, dispatched_on, created_at, updated_at
  ) select ${randomUUID()}, tenant_id, order_id, warehouse_id, 'dispatched',
      value, currency, picked_by, packed_by, 'direct-sql', ${today()},
      created_at, updated_at
    from shipments where tenant_id = ${fixture.tenantId} and id = ${shipmentId}`).rejects.toThrow(
    'cannot be inserted as dispatched',
  )
  await expect(administrator`update shipments
    set status = 'dispatched', dispatched_by = 'direct-sql', dispatched_on = ${today()}
    where tenant_id = ${fixture.tenantId} and id = ${shipmentId}`).rejects.toThrow(
    'lacks production fiscal authorization',
  )
  await expect(administrator`update shipments
    set status = 'returned', dispatched_by = 'direct-sql', dispatched_on = ${today()},
      returned_by = 'direct-sql', returned_on = ${today()}, closure_reason = 'direct-sql'
    where tenant_id = ${fixture.tenantId} and id = ${shipmentId}`).rejects.toThrow(
    'Scoped shipment must dispatch from its frozen packed state',
  )
  const digest = String(frozen?.payload_digest)
  await expect(
    administrator`insert into sales_fiscal_release_observations
      (tenant_id, event_id, shipment_id, origin_digest, order_version, establishment_id, document_id,
       document_revision, environment, outcome, observed_at)
      values (${fixture.tenantId}, ${randomUUID()}, ${shipmentId}, ${digest},
        ${orderVersion}, ${establishmentId}, ${randomUUID()}, 1, 'homologation', 'authorized', now())`,
  ).rejects.toThrow()
  expect((await dispatch()).isLeft()).toBe(true)
  await administrator`insert into sales_fiscal_release_observations
    (tenant_id, event_id, shipment_id, origin_digest, order_version, establishment_id, document_id,
     document_revision, environment, outcome, observed_at)
    values (${fixture.tenantId}, ${randomUUID()}, ${shipmentId}, ${'b'.repeat(64)},
      ${orderVersion}, ${establishmentId}, ${randomUUID()}, 1, 'production', 'authorized', now())`
  expect((await dispatch()).isLeft()).toBe(true)
  const handlers = new SalesModuleEventHandlers(database, clock, {
    enableProductionReleaseEvents: true,
  })
  const release = handlers.handlers['fiscal.document.production-outcome']
  if (!release) throw new Error('missing release handler')
  const event = {
    eventId: randomUUID(),
    eventType: 'fiscal.document.production-outcome',
    eventVersion: 1,
    occurredAt: clock.now().toISOString(),
    tenantId: fixture.tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload: {
      documentId: randomUUID(),
      documentRevision: 1,
      originModule: 'sales',
      originId: shipmentId,
      originDigest: digest,
      orderVersion,
      establishmentId,
      model: '55',
      environment: 'production',
      responseDigest: 'a'.repeat(64),
      observedAt: new Date(Date.now() + 1000).toISOString(),
      outcome: 'authorized',
      authorityReference: '135260000000001',
      protocolDigest: 'b'.repeat(64),
    },
  }
  await release(event)
  await release(event)
  const [projection] = await administrator`select count(*)::int as count
    from sales_fiscal_release_observations where tenant_id = ${fixture.tenantId}`
  expect(projection?.count).toBe(2)
  await administrator`insert into sales_fiscal_release_observations
    (tenant_id, event_id, shipment_id, origin_digest, order_version, establishment_id,
     document_id, document_revision, environment, outcome, observed_at)
    values (${fixture.tenantId}, ${randomUUID()}, ${shipmentId}, ${digest},
      ${orderVersion}, ${establishmentId}, ${event.payload.documentId}, 1,
      'production', 'rejected', now())`
  expect((await dispatch()).isLeft()).toBe(true)
  await expect(administrator`update shipments
    set status = 'dispatched', dispatched_by = 'direct-sql', dispatched_on = ${today()}
    where tenant_id = ${fixture.tenantId} and id = ${shipmentId}`).rejects.toThrow(
    'lacks production fiscal authorization',
  )
  await administrator`insert into sales_fiscal_release_observations
    (tenant_id, event_id, shipment_id, origin_digest, order_version, establishment_id,
     document_id, document_revision, environment, outcome, observed_at)
    values (${fixture.tenantId}, ${randomUUID()}, ${shipmentId}, ${digest},
      ${orderVersion}, ${establishmentId}, ${randomUUID()}, 2,
      'production', 'authorized', now())`
  expect((await dispatch()).isRight()).toBe(true)
  const [dispatched] = await administrator`select status from shipments where id = ${shipmentId}`
  expect(dispatched?.status).toBe('dispatched')
})

async function verifyRestoredFiscalGate(tenantId: string, shipmentId: string): Promise<void> {
  const source = e2ePostgresContainer()
  const backupPath = '/tmp/sales-phase43-backup.dump'
  const backup = await source.exec(
    [
      'pg_dump',
      '--format=custom',
      '--no-owner',
      '--file',
      backupPath,
      '-U',
      'postgres',
      '-d',
      'horizon_test',
    ],
    { env: { PGPASSWORD: 'test' } },
  )
  if (backup.exitCode !== 0) throw new Error(`Sales pg_dump failed: ${backup.stderr}`)
  let restoredContainer: StartedPostgreSqlContainer | null = null
  try {
    restoredContainer = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('horizon_sales_restored_test')
      .withUsername('postgres')
      .withPassword('test')
      .start()
    await restoredContainer.copyArchiveToContainer(
      (await source.copyArchiveFromContainer(backupPath)) as Readable,
      '/tmp',
    )
    const restoredUrl = restoredContainer.getConnectionUri()
    const restoredAdmin = postgres(restoredUrl, { max: 1 })
    try {
      await restoredAdmin.unsafe(
        `CREATE ROLE horizon_owner LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
         CREATE ROLE horizon_app LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
         CREATE ROLE horizon_relay LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;`,
        [],
        { prepare: false },
      )
      const restore = await restoredContainer.exec(
        [
          'pg_restore',
          '--no-owner',
          '--exit-on-error',
          '-U',
          'postgres',
          '-d',
          'horizon_sales_restored_test',
          backupPath,
        ],
        { env: { PGPASSWORD: 'test' } },
      )
      if (restore.exitCode !== 0) throw new Error(`Sales pg_restore failed: ${restore.stderr}`)
      const [restored] = await restoredAdmin`select status from shipments
        where tenant_id = ${tenantId} and id = ${shipmentId}`
      expect(restored?.status).toBe('packed')
      await expect(restoredAdmin`update shipments
        set status = 'dispatched', dispatched_by = 'direct-sql', dispatched_on = ${today()}
        where tenant_id = ${tenantId} and id = ${shipmentId}`).rejects.toThrow(
        'lacks production fiscal authorization',
      )
      const restoredDatabase = new SalesDatabase({
        url: restoredUrl.replace('postgres:test@', 'horizon_app:test@'),
      })
      try {
        const result = await new DispatchShipmentUseCase(restoredDatabase, clock).execute({
          context: commandOf(tenantId),
          shipmentId,
          dispatchedOn: today(),
        })
        expect(result.isLeft()).toBe(true)
      } finally {
        await restoredDatabase.close()
      }
    } finally {
      await restoredAdmin.end()
    }
  } finally {
    await restoredContainer?.stop()
  }
}

// --- Phase 49: a sales order is a goods order -----------------------------------------------

async function projectItem(tenantId: string, kind: 'product' | 'service', price = 5000n) {
  const itemId = randomUUID()
  const handlers = new SalesModuleEventHandlers(database, clock)
  const envelope = (eventType: string, payload: Record<string, unknown>) => ({
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload,
  })
  const created = envelope('catalog.item.created', {
    itemId,
    kind,
    sku: `P49-${itemId.slice(0, 8)}`,
    name: kind === 'service' ? 'Implantação assistida' : 'Café torrado',
    unitId: randomUUID(),
    ncm: kind === 'service' ? null : '09012100',
  })
  await handlers.handlers['catalog.item.created']?.(created)
  // A replay (or a forged kind on a later copy) never changes the recorded kind.
  await handlers.handlers['catalog.item.created']?.({
    ...created,
    eventId: randomUUID(),
    payload: { ...created.payload, kind: kind === 'service' ? 'product' : 'service' },
  })
  await handlers.handlers['catalog.price.changed']?.(
    envelope('catalog.price.changed', {
      itemId,
      priceListId: randomUUID(),
      amount: price.toString(),
      currency: 'BRL',
      effectiveFrom: new Date().toISOString(),
    }),
  )
  return itemId
}

it('projects the Catalog kind once and never changes it', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const service = await projectItem(tenantId, 'service')
  const good = await projectItem(tenantId, 'product')
  const rows = await administrator`select item_id, kind from catalog_items
    where tenant_id = ${tenantId} order by kind`
  expect(rows.map((row) => [row.item_id, row.kind])).toEqual([
    [good, 'product'],
    [service, 'service'],
  ])
  const kinds = await database.inTenant(tenantId, (scope) =>
    scope.catalogItems.kindsOf([service, good, randomUUID()]),
  )
  expect(Object.fromEntries(kinds)).toEqual({ [service]: 'service', [good]: 'product' })
  // Another tenant sees nothing of these rows.
  const other = randomUUID()
  await database.provisionTenant(other)
  expect(
    (await database.inTenant(other, (scope) => scope.catalogItems.kindsOf([service]))).size,
  ).toBe(0)
})

it('refuses a service in a sales order before Inventory is asked for anything', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const service = await projectItem(tenantId, 'service')
  const good = await projectItem(tenantId, 'product')
  const serviceLine = randomUUID()
  const refused = await new PlaceOrderUseCase(database, clock).execute({
    context: commandOf(tenantId),
    customerId: randomUUID(),
    fulfillmentWarehouseId: randomUUID(),
    lines: [
      { lineId: randomUUID(), itemId: good, quantity: '1' },
      { lineId: serviceLine, itemId: service, quantity: '1' },
    ],
  })
  expect(refused.isLeft()).toBe(true)
  expect(refused.value).toMatchObject({
    message: expect.stringContaining(`service items are delivered by a service order`),
  })
  expect((refused.value as Error).message).toContain(serviceLine)
  expect(
    await administrator`select 1 from sales_orders where tenant_id = ${tenantId}`,
  ).toHaveLength(0)
  expect(
    await administrator`select 1 from outbox where tenant_id = ${tenantId}
      and event_type = 'sales.order.placed'`,
  ).toHaveLength(0)

  // A goods order is placed exactly as before, and so is an item of unknown kind.
  const legacy = randomUUID()
  await administrator`insert into catalog_items
    (tenant_id, item_id, description, unit_price, currency, active, updated_at)
    values (${tenantId}, ${legacy}, 'Item antigo', 900, 'BRL', 1, now())`
  const placed = await new PlaceOrderUseCase(database, clock).execute({
    context: commandOf(tenantId),
    customerId: randomUUID(),
    fulfillmentWarehouseId: randomUUID(),
    lines: [
      { lineId: randomUUID(), itemId: good, quantity: '1' },
      { lineId: randomUUID(), itemId: legacy, quantity: '1' },
    ],
  })
  if (placed.isLeft()) throw placed.value
  const order = await database.findOrderSnapshot(tenantId, placed.value.orderId)
  expect(order?.requestedLines.map((line) => line.kind).sort()).toEqual([null, 'product'])
})

it('converts a mixed proposal into a sales order for its goods and a service order for its services', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const service = await projectItem(tenantId, 'service', 150000n)
  const good = await projectItem(tenantId, 'product')
  const customerId = randomUUID()
  const projected = await database.inTenant(tenantId, (scope) =>
    new ProjectPartyUseCase(clock).executeInScope(scope, {
      tenantId,
      partyId: customerId,
      legalName: 'Cliente Serviços',
      email: 'servicos@example.com',
      phone: '+55 11 99999-9999',
      address: 'Rua Um, 42, São Paulo',
      roles: ['customer'],
      active: true,
    }),
  )
  if (projected.isLeft()) throw projected.value
  const quote = await new WriteQuoteUseCase(database, clock, 15).execute({
    context: commandOf(tenantId),
    customerId,
    quote: {
      lines: [
        { lineId: randomUUID(), itemId: good, quantity: '2' },
        { lineId: randomUUID(), itemId: service, quantity: '1' },
      ],
    },
  })
  if (quote.isLeft()) throw quote.value
  const decide = new DecideQuoteUseCase(database, clock)
  expect((await decide.send(commandOf(tenantId), quote.value.quoteId)).isRight()).toBe(true)
  expect((await decide.accept(commandOf(tenantId), quote.value.quoteId)).isRight()).toBe(true)
  const read = await database.findQuoteSnapshot(tenantId, quote.value.quoteId)
  expect(read?.lines.map((line) => [line.itemId, line.kind])).toEqual(
    expect.arrayContaining([
      [good, 'product'],
      [service, 'service'],
    ]),
  )
  expect(read?.total).toBe('160000')

  const conversion = {
    context: commandOf(tenantId),
    quoteId: quote.value.quoteId,
    fulfillmentWarehouseId: randomUUID(),
  }
  const converted = await new ConvertQuoteUseCase(database, clock).execute(conversion)
  if (converted.isLeft()) throw converted.value
  const { orderId, serviceOrderId } = converted.value
  if (!orderId || !serviceOrderId) throw new Error('the proposal did not become both documents')
  const retried = await new ConvertQuoteUseCase(database, clock).execute(conversion)
  if (retried.isLeft()) throw retried.value
  expect(retried.value).toEqual(converted.value)

  const [after] = await administrator`select status, order_id, service_order_id from quotes
    where tenant_id = ${tenantId} and id = ${quote.value.quoteId}`
  expect(after).toEqual({ status: 'accepted', order_id: orderId, service_order_id: serviceOrderId })
  // The goods reach Inventory; the service never does.
  const placed = await administrator`select payload from outbox where tenant_id = ${tenantId}
    and event_type = 'sales.order.placed'`
  expect(placed).toHaveLength(1)
  expect(placed[0]?.payload.lines.map((line: { itemId: string }) => line.itemId)).toEqual([good])
  const serviceOrder = await database.findServiceOrderSnapshot(tenantId, serviceOrderId)
  expect(serviceOrder).toMatchObject({
    quoteId: quote.value.quoteId,
    status: 'scheduled',
    total: '150000',
    lines: [{ itemId: service, quantity: '1', delivered: '0' }],
  })
  // One proposal has one service order, whatever writes to the table.
  await expect(
    administrator`insert into service_orders (id, tenant_id, customer_id, quote_id, status,
        currency, net, discount, total, billed, payment_term_days, opened_on, created_by,
        version, created_at, updated_at)
      values (${randomUUID()}, ${tenantId}, ${customerId}, ${quote.value.quoteId}, 'scheduled',
        'BRL', 1, 0, 1, 0, '[0]', current_date, 'ana', 1, now(), now())`,
  ).rejects.toThrow(/service_orders_one_per_quote/)
})

it('backfills unknown kinds once and never overwrites a recorded one', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const known = await projectItem(tenantId, 'service')
  const old = randomUUID()
  await administrator`insert into catalog_items
    (tenant_id, item_id, description, unit_price, currency, active, updated_at)
    values (${tenantId}, ${old}, 'Consultoria antiga', 900, 'BRL', 1, now())`
  const unknown = await database.inTenant(tenantId, (scope) => scope.catalogItems.unknownKinds(100))
  expect(unknown).toEqual([old])
  const filled = await database.inTenant(tenantId, async (scope) => [
    await scope.catalogItems.backfillKind(old, 'service'),
    await scope.catalogItems.backfillKind(old, 'product'),
    await scope.catalogItems.backfillKind(known, 'product'),
  ])
  expect(filled).toEqual([true, false, false])
  const rows = await administrator`select item_id, kind from catalog_items
    where tenant_id = ${tenantId}`
  expect(Object.fromEntries(rows.map((row) => [row.item_id, row.kind]))).toEqual({
    [known]: 'service',
    [old]: 'service',
  })
})

it('keeps a price that arrives before its item', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const itemId = randomUUID()
  const handlers = new SalesModuleEventHandlers(database, clock)
  const envelope = (eventType: string, payload: Record<string, unknown>) => ({
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload,
  })
  await handlers.handlers['catalog.price.changed']?.(
    envelope('catalog.price.changed', {
      itemId,
      priceListId: randomUUID(),
      amount: '150000',
      currency: 'BRL',
      effectiveFrom: new Date().toISOString(),
    }),
  )
  await handlers.handlers['catalog.item.created']?.(
    envelope('catalog.item.created', {
      itemId,
      kind: 'service',
      sku: 'LATE-1',
      name: 'Suporte mensal',
      unitId: randomUUID(),
      ncm: null,
    }),
  )
  const item = await database.inTenant(tenantId, (scope) => scope.catalogItems.findById(itemId))
  expect(item).toMatchObject({ kind: 'service', active: true })
  expect(item?.description.value).toBe('Suporte mensal')
  expect(item?.unitPrice.amount).toBe(150000n)
})

async function serviceCustomer(tenantId: string) {
  const customerId = randomUUID()
  const projected = await database.inTenant(tenantId, (scope) =>
    new ProjectPartyUseCase(clock).executeInScope(scope, {
      tenantId,
      partyId: customerId,
      legalName: 'Cliente Serviços',
      email: 'servicos@example.com',
      phone: '+55 11 99999-9999',
      address: 'Rua Um, 42, São Paulo',
      roles: ['customer'],
      active: true,
    }),
  )
  if (projected.isLeft()) throw projected.value
  return customerId
}

it('delivers a service order in parts, publishes each delivery once and keeps a cancelled one', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const service = await projectItem(tenantId, 'service', 30000n)
  const customerId = await serviceCustomer(tenantId)
  const lineId = randomUUID()
  const opened = await new OpenServiceOrderUseCase(database, clock).execute({
    context: commandOf(tenantId),
    customerId,
    lines: [{ lineId, itemId: service, quantity: '3' }],
    terms: { discount: '1000', paymentTermDays: [0, 30] },
  })
  if (opened.isLeft()) throw opened.value
  const { serviceOrderId } = opened.value
  const decide = new DecideServiceOrderUseCase(database, clock)
  expect((await decide.start(commandOf(tenantId), serviceOrderId)).isRight()).toBe(true)

  const deliver = new DeliverServiceUseCase(database, clock)
  const partial = {
    context: commandOf(tenantId),
    serviceOrderId,
    lines: [{ lineId, quantity: '1' }],
    performedOn: today(),
  }
  const first = await deliver.execute(partial)
  if (first.isLeft()) throw first.value
  // A retried request answers with the delivery it made, and bills nothing twice.
  const retried = await deliver.execute(partial)
  if (retried.isLeft()) throw retried.value
  expect(retried.value).toEqual(first.value)
  const rest = await deliver.execute({ context: commandOf(tenantId), serviceOrderId })
  if (rest.isLeft()) throw rest.value
  expect(rest.value.status).toBe('completed')

  const delivered = await administrator`select payload from outbox where tenant_id = ${tenantId}
    and event_type = 'sales.service.delivered' order by created_at`
  expect(delivered).toHaveLength(2)
  const values = delivered.map((row) => BigInt(row.payload.value.amount))
  // 90000 less 1000 of discount: the first third carries 29666, the rest what is left.
  expect(values).toEqual([29666n, 59334n])
  expect(delivered[0]?.payload).toMatchObject({
    serviceOrderId,
    deliveryId: first.value.deliveryId,
    competence: today().slice(0, 7),
    lines: [{ lineId, itemId: service, quantity: '1', amount: { amount: '29666' } }],
    installments: [{ number: 1 }, { number: 2 }],
    complete: false,
  })

  expect(
    (
      await decide.cancelDelivery(
        commandOf(tenantId),
        serviceOrderId,
        first.value.deliveryId,
        'A primeira visita não aconteceu',
      )
    ).isRight(),
  ).toBe(true)
  const [cancelled] = await administrator`select payload from outbox where tenant_id = ${tenantId}
    and event_type = 'sales.service.delivery-cancelled'`
  expect(cancelled?.payload).toMatchObject({
    deliveryId: first.value.deliveryId,
    entryIds: [delivered[0]?.payload.lines[0].entryId],
    reason: 'A primeira visita não aconteceu',
  })
  const snapshot = await database.findServiceOrderSnapshot(tenantId, serviceOrderId)
  expect(snapshot).toMatchObject({
    status: 'in_progress',
    billed: '59334',
    lines: [{ quantity: '3', delivered: '2' }],
  })
  expect(snapshot?.deliveries.map((delivery) => delivery.status)).toEqual(['cancelled', 'active'])

  // A recorded delivery is never rewritten, and a cancelled one never comes back.
  await expect(
    administrator`update service_deliveries set value = 1 where id = ${rest.value.deliveryId}`,
  ).rejects.toThrow(/never rewritten/)
  await expect(
    administrator`update service_deliveries set status = 'active', cancelled_by = null,
      cancelled_on = null, cancellation_reason = null where id = ${first.value.deliveryId}`,
  ).rejects.toThrow(/never rewritten/)
  await expect(
    application.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await tx`update service_delivery_lines set amount = 1`
    }),
  ).rejects.toThrow(/permission denied/)
})

it('isolates service orders and their deliveries by tenant', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const service = await projectItem(tenantId, 'service')
  const customerId = await serviceCustomer(tenantId)
  const opened = await new OpenServiceOrderUseCase(database, clock).execute({
    context: commandOf(tenantId),
    customerId,
    lines: [{ lineId: randomUUID(), itemId: service, quantity: '1' }],
  })
  if (opened.isLeft()) throw opened.value
  const { serviceOrderId } = opened.value
  const decide = new DecideServiceOrderUseCase(database, clock)
  expect((await decide.start(commandOf(tenantId), serviceOrderId)).isRight()).toBe(true)
  const delivered = await new DeliverServiceUseCase(database, clock).execute({
    context: commandOf(tenantId),
    serviceOrderId,
  })
  if (delivered.isLeft()) throw delivered.value

  const other = randomUUID()
  await database.provisionTenant(other)
  expect(await database.findServiceOrderSnapshot(other, serviceOrderId)).toBeNull()
  expect(await database.listServiceOrderSnapshots(other)).toEqual([])
  expect((await decide.accept(commandOf(other), serviceOrderId)).isLeft()).toBe(true)
  await application.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${other}, true)`
    for (const table of [
      'service_orders',
      'service_order_lines',
      'service_deliveries',
      'service_delivery_lines',
    ])
      expect(await tx`select 1 from ${tx(table)}`).toHaveLength(0)
    const changed = await tx`update service_orders set status = 'cancelled'
      where id = ${serviceOrderId}`
    expect(changed.count).toBe(0)
  })
  // Goods are refused on a service order: they belong on a sales order.
  const good = await projectItem(tenantId, 'product')
  const refused = await new OpenServiceOrderUseCase(database, clock).execute({
    context: commandOf(tenantId),
    customerId,
    lines: [{ lineId: randomUUID(), itemId: good, quantity: '1' }],
  })
  expect(refused.isLeft()).toBe(true)
})

function firstStart(contract: { revisions(): readonly { effectiveFrom: BusinessDate }[] }) {
  const [first] = contract.revisions()
  if (!first) throw new Error('a contract has its first revision')
  return first.effectiveFrom
}

/** The first day of the month `months` from the current UTC month. */
function monthStart(months: number): string {
  const day = clock.now()
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + months, 1))
    .toISOString()
    .slice(0, 10)
}

it('keeps a contract in insert-only revisions and publishes each change', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const service = await projectItem(tenantId, 'service', 80000n)
  const customerId = await serviceCustomer(tenantId)
  const created = await new CreateContractUseCase(database, clock).execute({
    context: commandOf(tenantId),
    customerId,
    lines: [{ lineId: randomUUID(), itemId: service, quantity: '1' }],
    recurrence: 'monthly',
    startsOn: monthStart(1),
    endsOn: monthStart(13),
    billingDay: 10,
    autoRenew: true,
  })
  // An end date on the first of a month ends mid-period: refused.
  expect(created.isLeft()).toBe(true)
  const endsOn = new Date(Date.parse(`${monthStart(13)}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10)
  const contract = await new CreateContractUseCase(database, clock).execute({
    context: commandOf(tenantId),
    customerId,
    lines: [{ lineId: randomUUID(), itemId: service, quantity: '1' }],
    recurrence: 'monthly',
    startsOn: monthStart(1),
    endsOn,
    billingDay: 10,
    autoRenew: true,
  })
  if (contract.isLeft()) throw contract.value
  const { contractId } = contract.value
  const decide = new DecideContractUseCase(database, clock)
  expect((await decide.activate(commandOf(tenantId), contractId)).isRight()).toBe(true)
  const amended = await new AmendContractUseCase(database, clock).execute({
    context: commandOf(tenantId),
    contractId,
    effectiveFrom: monthStart(3),
    lines: [{ lineId: randomUUID(), itemId: service, quantity: '2', unitPrice: '75000' }],
    recurrence: 'monthly',
    reason: 'Dois postos de atendimento',
  })
  if (amended.isLeft()) throw amended.value
  expect(
    (
      await decide.suspend(commandOf(tenantId), contractId, {
        from: monthStart(5),
        reason: 'Obra no cliente',
      })
    ).isRight(),
  ).toBe(true)
  expect((await decide.resume(commandOf(tenantId), contractId, monthStart(7))).isRight()).toBe(true)
  const renewed = await new RenewContractUseCase(database, clock).execute({
    context: commandOf(tenantId),
    contractId,
    readjustmentBasisPoints: 300,
    reason: 'Renovação anual com reajuste',
  })
  if (renewed.isLeft()) throw renewed.value

  const read = await database.findContract(tenantId, contractId)
  if (!read) throw new Error('the contract vanished')
  const periods = read.schedule({
    from: firstStart(read),
    to: firstStart(read).plusDays(800),
  })
  expect(periods).toHaveLength(24)
  expect(periods.map((period) => period.revision).slice(0, 3)).toEqual([1, 1, 2])
  expect(periods.filter((period) => period.excluded === 'suspended')).toHaveLength(2)
  expect(periods[12]?.amount.amount).toBe(154500n)

  const events = await administrator`select event_type from outbox
    where tenant_id = ${tenantId} and event_type like 'sales.contract.%' order by created_at`
  expect(events.map((row) => row.event_type)).toEqual([
    'sales.contract.activated',
    'sales.contract.amended',
    'sales.contract.suspended',
    'sales.contract.suspended',
    'sales.contract.amended',
  ])
  // What a revision billed is never rewritten, and a resumption is written once.
  await expect(
    application.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await tx`update service_contract_revision_lines set unit_price = 1`
    }),
  ).rejects.toThrow(/permission denied/)
  await expect(
    administrator`update service_contract_suspensions set until_date = until_date + 31
      where contract_id = ${contractId}`,
  ).rejects.toThrow(/only gains its resumption/)

  // Another tenant sees none of it.
  const other = randomUUID()
  await database.provisionTenant(other)
  expect(await database.findContract(other, contractId)).toBeNull()
  expect((await decide.activate(commandOf(other), contractId)).isLeft()).toBe(true)
  await application.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${other}, true)`
    for (const table of [
      'service_contracts',
      'service_contract_revisions',
      'service_contract_revision_lines',
      'service_contract_suspensions',
    ])
      expect(await tx`select 1 from ${tx(table)}`).toHaveLength(0)
  })
})

it('renews a due contract by itself once, with no gap in its periods', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const service = await projectItem(tenantId, 'service', 30000n)
  const customerId = await serviceCustomer(tenantId)
  const contract = await new CreateContractUseCase(database, clock).execute({
    context: commandOf(tenantId),
    customerId,
    lines: [{ lineId: randomUUID(), itemId: service, quantity: '1' }],
    recurrence: 'monthly',
    startsOn: monthStart(-2),
    endsOn: new Date(Date.parse(`${monthStart(1)}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10),
    billingDay: 1,
    autoRenew: true,
  })
  if (contract.isLeft()) throw contract.value
  const { contractId } = contract.value
  expect(
    (
      await new DecideContractUseCase(database, clock).activate(commandOf(tenantId), contractId)
    ).isRight(),
  ).toBe(true)
  const renew = new RenewDueContractsUseCase(database, clock)
  const context = { tenantId, actor: 'user:operator', requestId: null }
  expect((await renew.execute(context)).renewed).toEqual([contractId])
  expect((await renew.execute(context)).renewed).toEqual([])
  const read = await database.findContract(tenantId, contractId)
  if (!read) throw new Error('the contract vanished')
  const periods = read.schedule({
    from: firstStart(read),
    to: firstStart(read).plusDays(200),
  })
  expect(periods).toHaveLength(6)
  for (const [index, period] of periods.entries()) {
    const next = periods[index + 1]
    if (next) expect(period.endsOn.plusDays(1).value).toBe(next.startsOn.value)
  }
  const [revision] = await administrator`select kind, created_by from service_contract_revisions
    where contract_id = ${contractId} and revision = 2`
  expect(revision).toEqual({ kind: 'renewal', created_by: 'system:contract-renewal' })
})

/** A monthly contract from last month, billed on the 1st, activated. */
async function billableContract(tenantId: string, service: string, customerId: string) {
  const created = await new CreateContractUseCase(database, clock).execute({
    context: commandOf(tenantId),
    customerId,
    lines: [{ lineId: randomUUID(), itemId: service, quantity: '2' }],
    recurrence: 'monthly',
    startsOn: monthStart(-1),
    billingDay: 1,
    paymentTermDays: [10],
  })
  if (created.isLeft()) throw created.value
  const activated = await new DecideContractUseCase(database, clock).activate(
    commandOf(tenantId),
    created.value.contractId,
  )
  if (activated.isLeft()) throw activated.value
  return created.value.contractId
}

function billingRuns() {
  const process = new ProcessBillingRunUseCase(database, clock)
  const start = (processing: Pick<ProcessBillingRunUseCase, 'execute'> = process) =>
    new StartBillingRunUseCase(
      database,
      clock,
      new RenewDueContractsUseCase(database, clock),
      processing,
    )
  return { process, start }
}

function envelope(tenantId: string, eventType: string, payload: unknown) {
  return {
    eventId: randomUUID(),
    tenantId,
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    traceId: randomBytes(16).toString('hex'),
    payload,
  }
}

it('bills a month once however it is re-run or resumed, and credits a period in place', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const service = await projectItem(tenantId, 'service', 30000n)
  const customerId = await serviceCustomer(tenantId)
  const first = await billableContract(tenantId, service, customerId)
  const second = await billableContract(tenantId, service, customerId)
  const month = monthStart(0).slice(0, 7)
  const { process, start } = billingRuns()
  const context = { tenantId, actor: 'user:billing', requestId: null }

  // The run stops after one contract, as a crash would leave it.
  const key = randomUUID()
  const stopsAfterOne = {
    execute: (runContext: typeof context, runId: string) =>
      process.execute(runContext, runId, { limit: 1 }),
  }
  const stopped = await start(stopsAfterOne).execute({
    context: { ...context, idempotencyKey: key },
    competence: month,
  })
  if (stopped.isLeft()) throw stopped.value
  expect(stopped.value.status).toBe('running')
  expect(stopped.value.items.map((item) => item.outcome).sort()).toEqual(['billed', 'pending'])
  // The same key finds the same run and finishes it.
  const resumed = await start().execute({
    context: { ...context, idempotencyKey: key },
    competence: month,
  })
  if (resumed.isLeft()) throw resumed.value
  expect(resumed.value).toMatchObject({ id: stopped.value.id, status: 'completed' })
  expect(resumed.value.items.map((item) => item.outcome)).toEqual(['billed', 'billed'])
  // A new run of the same month bills nothing, and says why.
  const rerun = await start().execute({ context: commandOf(tenantId), competence: month })
  if (rerun.isLeft()) throw rerun.value
  expect(rerun.value.items.map((item) => item.reason)).toEqual(['already-billed', 'already-billed'])
  const single = await new BillPeriodUseCase(database, clock).execute({
    context: commandOf(tenantId),
    contractId: first,
    competence: month,
  })
  expect(single.isLeft()).toBe(true)
  // Last month is still there to bill.
  const earlier = await start().execute({
    context: commandOf(tenantId),
    competence: monthStart(-1).slice(0, 7),
  })
  if (earlier.isLeft()) throw earlier.value
  expect(earlier.value.items.map((item) => item.outcome)).toEqual(['billed', 'billed'])

  const billed = await administrator`select payload from outbox where tenant_id = ${tenantId}
    and event_type = 'sales.contract-period.billed' order by created_at`
  expect(billed).toHaveLength(4)
  const keys = billed.map((row) => `${row.payload.contractId}/${row.payload.competence}`)
  expect(new Set(keys).size).toBe(4)
  const current = billed.filter((row) => row.payload.competence === month)
  expect(current.map((row) => row.payload.runId)).toEqual([stopped.value.id, stopped.value.id])
  expect(current[0]?.payload).toMatchObject({
    startsOn: monthStart(0),
    issuedOn: monthStart(0),
    value: { amount: '60000', currency: 'BRL' },
    installments: [{ number: 1, amount: { amount: '60000' } }],
  })

  // A later change never reaches the billed month.
  const amended = await new AmendContractUseCase(database, clock).execute({
    context: commandOf(tenantId),
    contractId: first,
    effectiveFrom: monthStart(0),
    lines: [{ lineId: randomUUID(), itemId: service, quantity: '1' }],
    recurrence: 'monthly',
    reason: 'Tentativa de mudar o mês faturado',
  })
  expect(amended.isLeft()).toBe(true)

  // The owners report back; what is still missing shows as a gap.
  const [period] = await administrator`select id from contract_billed_periods
    where contract_id = ${first} and competence = ${month}`
  const [line] = await administrator`select entry_id from contract_billed_period_lines
    where billed_period_id = ${period?.id}`
  const soon = new Date(Date.now() + 60_000)
  const gapsBefore = await database.billingGaps(tenantId, soon)
  expect(gapsBefore).toHaveLength(4)
  const handlers = new SalesModuleEventHandlers(database, clock).handlers
  const titleId = randomUUID()
  await handlers['financial.receivable.posted']?.(
    envelope(tenantId, 'financial.receivable.posted', {
      titleId,
      partyId: customerId,
      documentNumber: 'CT-00000001',
      origin: { type: 'sales-contract-period', documentId: period?.id },
      categoryId: randomUUID(),
      issuedOn: monthStart(0),
      competenceOn: monthStart(0),
      total: { amount: '60000', currency: 'BRL' },
      installments: [
        { number: 1, dueOn: monthStart(1), amount: { amount: '60000', currency: 'BRL' } },
      ],
      allocations: [],
      postedAt: new Date().toISOString(),
    }),
  )
  const documentId = randomUUID()
  await handlers['fiscal.service-document.simulation-outcome']?.(
    envelope(tenantId, 'fiscal.service-document.simulation-outcome', {
      documentId,
      rootDocumentId: documentId,
      revision: 1,
      serviceOriginId: randomUUID(),
      sourceKey: {
        module: 'sales',
        documentType: 'contract-period',
        id: line?.entry_id,
        period: month,
      },
      municipalityCode: '3550308',
      competence: month,
      model: 'nfse',
      environment: 'simulation',
      simulated: true,
      adapterVersion: 'nfse-simulator/1',
      statusDigest: 'a'.repeat(64),
      observedAt: new Date().toISOString(),
      outcome: 'authorized',
      authorityReference: 'NFSE-1',
      protocolDigest: 'b'.repeat(64),
      substitutesDocumentId: null,
    }),
  )
  const gapsAfter = await database.billingGaps(tenantId, soon)
  expect(gapsAfter.map((gap) => gap.billedPeriodId)).not.toContain(period?.id)
  const withEffects = await database.findContractWithEffects(tenantId, first)
  expect(withEffects?.effects.periods.get(String(period?.id))).toMatchObject({
    receivableTitleId: titleId,
  })
  expect(withEffects?.effects.lines.get(String(line?.entry_id))).toMatchObject({
    nfseDocumentId: documentId,
    nfseStatus: 'authorized',
  })

  // A credit keeps the period, marked credited, and publishes the lines it withdraws.
  const credit = new CreditPeriodUseCase(database, clock)
  const credited = await credit.execute({
    context: commandOf(tenantId),
    contractId: second,
    competence: month,
    reasonCode: 'not-provided',
    reason: 'O posto ficou fechado no mês',
  })
  if (credited.isLeft()) throw credited.value
  const [creditEvent] = await administrator`select payload from outbox
    where tenant_id = ${tenantId} and event_type = 'sales.contract-period.credited'`
  expect(creditEvent?.payload).toMatchObject({
    contractId: second,
    billedPeriodId: credited.value.billedPeriodId,
    reasonCode: 'not-provided',
    competence: month,
  })
  const [kept] = await administrator`select value, credit_reason_code from contract_billed_periods
    where id = ${credited.value.billedPeriodId}`
  expect(kept).toEqual({ value: '60000', credit_reason_code: 'not-provided' })
  expect(
    (
      await credit.execute({
        context: commandOf(tenantId),
        contractId: second,
        competence: month,
        reasonCode: 'billing-error',
        reason: 'De novo',
      })
    ).isLeft(),
  ).toBe(true)

  // What was billed, credited and decided is never rewritten.
  await expect(
    administrator`update contract_billed_periods set value = 1 where id = ${period?.id}`,
  ).rejects.toThrow(/never changes what it billed/)
  await expect(
    administrator`update contract_billed_periods set credit_reason = 'Outro motivo'
      where id = ${credited.value.billedPeriodId}`,
  ).rejects.toThrow(/never rewritten/)
  await expect(
    administrator`update contract_billed_period_lines set amount = 1
      where billed_period_id = ${period?.id}`,
  ).rejects.toThrow(/never changes what it billed/)
  await expect(
    administrator`update contract_billing_run_items set outcome = 'skipped',
      reason = 'suspended' where run_id = ${stopped.value.id}`,
  ).rejects.toThrow(/decided once/)
  await expect(
    administrator`insert into contract_billed_periods (id, tenant_id, contract_id, competence,
        revision, starts_on, ends_on, issued_on, currency, value, installments, billed_by,
        billed_at)
      select gen_random_uuid(), tenant_id, contract_id, competence, revision, starts_on,
        ends_on, issued_on, currency, value, installments, billed_by, billed_at
      from contract_billed_periods where id = ${period?.id}`,
  ).rejects.toThrow(/contract_billed_periods_once/)
})

it('isolates billed periods and runs by tenant, and lets the relay only count them', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const service = await projectItem(tenantId, 'service', 30000n)
  const contractId = await billableContract(tenantId, service, await serviceCustomer(tenantId))
  const billed = await new BillPeriodUseCase(database, clock).execute({
    context: commandOf(tenantId),
    contractId,
    competence: monthStart(0).slice(0, 7),
  })
  if (billed.isLeft()) throw billed.value
  const run = await billingRuns()
    .start()
    .execute({ context: commandOf(tenantId), competence: monthStart(-1).slice(0, 7) })
  if (run.isLeft()) throw run.value

  const other = randomUUID()
  await database.provisionTenant(other)
  expect(await database.findBillingRun(other, run.value.id)).toBeNull()
  expect(await database.listBillingRuns(other, null)).toEqual([])
  expect(await database.billingGaps(other, new Date(Date.now() + 60_000))).toEqual([])
  const foreign = await new CreditPeriodUseCase(database, clock).execute({
    context: commandOf(other),
    contractId,
    competence: monthStart(0).slice(0, 7),
    reasonCode: 'not-provided',
    reason: 'Tentativa de outro tenant',
  })
  expect(foreign.isLeft()).toBe(true)
  await application.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${other}, true)`
    for (const table of [
      'contract_billed_periods',
      'contract_billed_period_lines',
      'contract_billing_runs',
      'contract_billing_run_items',
    ])
      expect(await tx`select 1 from ${tx(table)}`).toHaveLength(0)
    const changed = await tx`update contract_billed_periods set receivable_posted_at = now()`
    expect(changed.count).toBe(0)
  })

  const container = e2ePostgresContainer()
  const relayUrl = `postgres://horizon_relay:test@${container.getHost()}:${container.getMappedPort(5432)}/horizon_test`
  const relay = postgres(relayUrl, { max: 1 })
  try {
    await expect(relay`select tenant_id from contract_billed_periods`).rejects.toThrow(
      /permission denied/,
    )
    await expect(relay`select amount from contract_billed_period_lines`).rejects.toThrow(
      /permission denied/,
    )
    await expect(relay`select * from contract_billing_runs`).rejects.toThrow(/permission denied/)
  } finally {
    await relay.end()
  }
  const gauges = new BillingGauges({ databaseUrl: relayUrl, thresholdSeconds: 1 })
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    const counted = await gauges.refresh()
    expect(counted?.withoutReceivable).toBeGreaterThanOrEqual(2)
    expect(counted?.withoutNfse).toBeGreaterThanOrEqual(2)
  } finally {
    await gauges.onModuleDestroy()
  }
})

it('follows the receivable and NFS-e of each delivery, and keeps them apart per tenant', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const service = await projectItem(tenantId, 'service', 30000n)
  const customerId = await serviceCustomer(tenantId)
  const opened = await new OpenServiceOrderUseCase(database, clock).execute({
    context: commandOf(tenantId),
    customerId,
    lines: [{ lineId: randomUUID(), itemId: service, quantity: '1' }],
  })
  if (opened.isLeft()) throw opened.value
  const { serviceOrderId } = opened.value
  const decide = new DecideServiceOrderUseCase(database, clock)
  expect((await decide.start(commandOf(tenantId), serviceOrderId)).isRight()).toBe(true)
  const delivered = await new DeliverServiceUseCase(database, clock).execute({
    context: commandOf(tenantId),
    serviceOrderId,
  })
  if (delivered.isLeft()) throw delivered.value
  const { deliveryId } = delivered.value
  const [entry] = await administrator`select entry_id from service_delivery_lines
    where delivery_id = ${deliveryId}`

  const handlers = new SalesModuleEventHandlers(database, clock).handlers
  const titleId = randomUUID()
  const posted = envelope(tenantId, 'financial.receivable.posted', {
    titleId,
    partyId: customerId,
    documentNumber: 'SV-00000001',
    origin: { type: 'sales-service-delivery', documentId: deliveryId },
    categoryId: randomUUID(),
    issuedOn: today(),
    competenceOn: today(),
    total: { amount: '30000', currency: 'BRL' },
    installments: [{ number: 1, dueOn: today(), amount: { amount: '30000', currency: 'BRL' } }],
    allocations: [],
    postedAt: new Date().toISOString(),
  })
  await handlers['financial.receivable.posted']?.(posted)
  await handlers['financial.receivable.posted']?.({ ...posted, eventId: randomUUID() })
  const documentId = randomUUID()
  const outcome = (status: 'authorized' | 'cancelled', observedAt: string) =>
    envelope(tenantId, 'fiscal.service-document.simulation-outcome', {
      documentId,
      rootDocumentId: documentId,
      revision: 1,
      serviceOriginId: randomUUID(),
      sourceKey: {
        module: 'sales',
        documentType: 'service-delivery',
        id: entry?.entry_id,
        period: today().slice(0, 7),
      },
      municipalityCode: '3550308',
      competence: today().slice(0, 7),
      model: 'nfse',
      environment: 'simulation',
      simulated: true,
      adapterVersion: 'nfse-simulator/1',
      statusDigest: 'c'.repeat(64),
      observedAt,
      ...(status === 'authorized'
        ? {
            outcome: 'authorized',
            authorityReference: 'NFSE-9',
            protocolDigest: 'd'.repeat(64),
            substitutesDocumentId: null,
          }
        : {
            outcome: 'cancelled',
            authorityReference: 'NFSE-9',
            protocolDigest: 'e'.repeat(64),
            cancellation: { kind: 'event-101101' },
          }),
    })
  const later = new Date().toISOString()
  const earlier = new Date(Date.now() - 60_000).toISOString()
  await handlers['fiscal.service-document.simulation-outcome']?.(outcome('cancelled', later))
  // An older authorization arriving late never hides the cancellation.
  await handlers['fiscal.service-document.simulation-outcome']?.(outcome('authorized', earlier))
  await handlers['financial.receivable.reversed']?.(
    envelope(tenantId, 'financial.receivable.reversed', {
      titleId,
      partyId: customerId,
      reversedAt: later,
      reason: 'Serviço não prestado',
    }),
  )

  const found = await database.findServiceOrderWithEffects(tenantId, serviceOrderId)
  expect(found?.effects.receivables.get(deliveryId)).toMatchObject({ receivableTitleId: titleId })
  expect(found?.effects.receivables.get(deliveryId)?.receivableReversedAt).toBeInstanceOf(Date)
  expect(found?.effects.nfse.get(String(entry?.entry_id))).toMatchObject({
    documentId,
    status: 'cancelled',
  })

  const other = randomUUID()
  await database.provisionTenant(other)
  expect(await database.findServiceOrderWithEffects(other, serviceOrderId)).toBeNull()
  await application.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${other}, true)`
    for (const table of ['service_delivery_effects', 'service_delivery_line_nfse'])
      expect(await tx`select 1 from ${tx(table)}`).toHaveLength(0)
  })
})
