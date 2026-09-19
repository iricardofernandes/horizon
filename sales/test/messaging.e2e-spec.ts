import { randomBytes, randomUUID } from 'node:crypto'
import { type Channel, type ChannelModel, connect } from 'amqplib'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { SalesModuleEventHandlers } from '@/application/consume-module-events'
import { PlaceOrderUseCase } from '@/application/use-cases/place-order'
import { SalesDatabase } from '@/infrastructure/database/drizzle/sales-database'
import { RabbitMqEventConsumer } from '@/infrastructure/messaging/rabbitmq-transport'

let database: SalesDatabase
let administrator: ReturnType<typeof postgres>
let consumer: RabbitMqEventConsumer
let broker: ChannelModel
let publisher: Channel
const queue = `sales.events-${randomBytes(4).toString('hex')}`

beforeAll(async () => {
  database = new SalesDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  broker = await connect(process.env.RABBITMQ_URL ?? '')
  publisher = await broker.createChannel()
  const handlers = new SalesModuleEventHandlers(database, { now: () => new Date() })
  consumer = new RabbitMqEventConsumer({
    url: process.env.RABBITMQ_URL ?? '',
    queue,
    handlers: handlers.handlers,
    prefetch: 5,
  })
  await consumer.start()
})

afterAll(async () => {
  await consumer?.close()
  await publisher?.close()
  await Promise.allSettled([broker?.close(), database?.close(), administrator?.end()])
})

function envelope(
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
  eventId = randomUUID(),
) {
  return {
    eventId,
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload,
  }
}

function publish(event: ReturnType<typeof envelope>): void {
  publisher.publish('horizon.events', event.eventType, Buffer.from(JSON.stringify(event)), {
    persistent: true,
    contentType: 'application/json',
    messageId: event.eventId,
  })
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for messaging effect')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

it('projects catalog events and confirms an order from an inventory outcome exactly once', async () => {
  const tenantId = randomUUID()
  const itemId = randomUUID()
  await database.provisionTenant(tenantId)
  publish(
    envelope(tenantId, 'catalog.item.created', {
      itemId,
      kind: 'product',
      sku: 'COFFEE-1',
      name: 'Roasted coffee',
      unitId: randomUUID(),
      ncm: '09012100',
    }),
  )
  publish(
    envelope(tenantId, 'catalog.price.changed', {
      priceListId: randomUUID(),
      itemId,
      amount: '1250',
      currency: 'BRL',
    }),
  )
  await waitFor(async () => {
    const [row] = await administrator`select unit_price from catalog_items
      where tenant_id = ${tenantId} and item_id = ${itemId}`
    return row?.unit_price === '1250' ? row : null
  })

  const placed = await new PlaceOrderUseCase(database, { now: () => new Date() }).execute({
    context: { tenantId, actor: 'ana', requestId: null, idempotencyKey: randomUUID() },
    customerId: randomUUID(),
    fulfillmentWarehouseId: randomUUID(),
    lines: [{ lineId: randomUUID(), itemId, quantity: '2' }],
  })
  if (placed.isLeft()) throw placed.value
  const outcome = envelope(tenantId, 'inventory.stock.reserved', {
    orderId: placed.value.orderId,
    orderVersion: 1,
    reservationId: randomUUID(),
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    lines: [{ lineId: randomUUID(), itemId, warehouseId: randomUUID(), quantity: '2' }],
  })
  publish(outcome)
  publish(outcome)

  await waitFor(async () => {
    const [row] = await administrator`select status, total from sales_orders
      where tenant_id = ${tenantId} and id = ${placed.value.orderId}`
    return row?.status === 'confirmed' ? row : null
  })
  const [order] = await administrator`select status, version, total, currency from sales_orders
    where id = ${placed.value.orderId}`
  expect(order).toEqual({ status: 'confirmed', version: 2, total: '2500', currency: 'BRL' })
  expect(await administrator`select * from inbox where tenant_id = ${tenantId}`).toHaveLength(3)
  const outbox = await administrator`select event_type from outbox
    where tenant_id = ${tenantId} order by created_at`
  expect(outbox.map((event) => event.event_type)).toEqual([
    'sales.order.placed',
    'sales.order.confirmed',
    'sales.invoicing.requested',
  ])
})

it('applies a reservation rejection once and ignores its redelivery', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const placed = await new PlaceOrderUseCase(database, { now: () => new Date() }).execute({
    context: { tenantId, actor: 'ana', requestId: null, idempotencyKey: randomUUID() },
    customerId: randomUUID(),
    fulfillmentWarehouseId: randomUUID(),
    lines: [{ lineId: randomUUID(), itemId: randomUUID(), quantity: '1' }],
  })
  if (placed.isLeft()) throw placed.value
  const rejected = envelope(tenantId, 'inventory.stock.reservation-rejected', {
    orderId: placed.value.orderId,
    orderVersion: 1,
    shortfalls: [
      {
        lineId: randomUUID(),
        itemId: randomUUID(),
        warehouseId: randomUUID(),
        quantity: '1',
        availableQuantity: '0',
      },
    ],
  })
  publish(rejected)
  publish(rejected)
  await waitFor(async () => {
    const [row] = await administrator`select status, version from sales_orders
      where id = ${placed.value.orderId}`
    return row?.status === 'rejected' ? row : null
  })
  const [order] = await administrator`select status, version from sales_orders
    where id = ${placed.value.orderId}`
  expect(order).toEqual({ status: 'rejected', version: 2 })
  expect(
    await administrator`select * from inbox where event_id = ${rejected.eventId}`,
  ).toHaveLength(1)
})
