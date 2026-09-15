import { randomBytes, randomUUID } from 'node:crypto'
import { type Channel, type ChannelModel, connect } from 'amqplib'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { InventorySalesEventHandlers } from '@/application/consume-sales-events'
import { InventoryDatabase } from '@/infrastructure/database/drizzle/inventory-database'
import {
  OutboxRelay,
  RabbitMqEventConsumer,
  RabbitMqEventPublisher,
} from '@/infrastructure/messaging/rabbitmq-transport'

let database: InventoryDatabase
let administrator: ReturnType<typeof postgres>
let consumer: RabbitMqEventConsumer
let broker: ChannelModel
let publisher: Channel
let sink: Channel
let relayUrl: string
const queue = `inventory.events-${randomBytes(4).toString('hex')}`

beforeAll(async () => {
  database = new InventoryDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  await administrator`alter role horizon_relay login password 'test'`
  const url = new URL(process.env.DATABASE_URL ?? '')
  url.username = 'horizon_relay'
  url.password = 'test'
  relayUrl = url.toString()
  broker = await connect(process.env.RABBITMQ_URL ?? '')
  publisher = await broker.createChannel()
  sink = await broker.createChannel()
  await sink.assertExchange('horizon.events', 'topic', { durable: true })
  await sink.assertQueue(`${queue}.sink`, { exclusive: true })
  await sink.bindQueue(`${queue}.sink`, 'horizon.events', 'inventory.#')
  const handlers = new InventorySalesEventHandlers(database, { now: () => new Date() }, 900)
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
  await Promise.allSettled([publisher?.close(), sink?.close()])
  await Promise.allSettled([broker?.close(), database?.close(), administrator?.end()])
})

async function seedBalance() {
  const tenantId = randomUUID()
  const warehouseId = randomUUID()
  const itemId = randomUUID()
  await database.provisionTenant(tenantId)
  await administrator`insert into warehouses (id, tenant_id, name, created_at, updated_at)
    values (${warehouseId}, ${tenantId}, 'Main', now(), now())`
  await administrator`insert into stock_balances
    (id, tenant_id, item_id, warehouse_id, on_hand, reserved, average_unit_cost, currency, version, updated_at)
    values (${randomUUID()}, ${tenantId}, ${itemId}, ${warehouseId}, 10000000, 0, 100, 'BRL', 0, now())`
  return { tenantId, warehouseId, itemId }
}

function placedEvent(fixture: Awaited<ReturnType<typeof seedBalance>>) {
  return {
    eventId: randomUUID(),
    eventType: 'sales.order.placed',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId: fixture.tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload: {
      orderId: randomUUID(),
      orderVersion: 1,
      customerId: randomUUID(),
      fulfillmentWarehouseId: fixture.warehouseId,
      lines: [{ lineId: randomUUID(), itemId: fixture.itemId, quantity: '4' }],
    },
  }
}

function publish(event: ReturnType<typeof placedEvent>): void {
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

it('consumes a placed order exactly once and commits inbox with the reservation', async () => {
  const fixture = await seedBalance()
  const event = placedEvent(fixture)
  publish(event)
  publish(event)
  await waitFor(async () => {
    const rows = await administrator`select id from stock_reservations
      where tenant_id = ${fixture.tenantId} and order_id = ${event.payload.orderId}`
    return rows.length === 1 ? rows : null
  })
  const [balance] = await administrator`select reserved from stock_balances
    where tenant_id = ${fixture.tenantId} and item_id = ${fixture.itemId}`
  expect(balance?.reserved).toBe('4000000')
  expect(await administrator`select * from inbox where event_id = ${event.eventId}`).toHaveLength(1)
  expect(
    await administrator`select * from outbox where tenant_id = ${fixture.tenantId}`,
  ).toHaveLength(1)
})

it('keeps a row pending after relay failure and publishes it after restart', async () => {
  const fixture = await seedBalance()
  const event = placedEvent(fixture)
  publish(event)
  await waitFor(async () => {
    const rows = await administrator`select id from outbox
      where tenant_id = ${fixture.tenantId} and dispatched_at is null`
    return rows.length === 1 ? rows : null
  })
  const failing = new OutboxRelay(relayUrl, {
    publish: async () => {
      throw new Error('relay killed')
    },
  })
  try {
    await expect(failing.flush()).rejects.toThrow('relay killed')
  } finally {
    await failing.close()
  }
  expect(
    await administrator`select id from outbox
      where tenant_id = ${fixture.tenantId} and dispatched_at is null`,
  ).toHaveLength(1)

  const rabbitPublisher = await RabbitMqEventPublisher.open(process.env.RABBITMQ_URL ?? '')
  const restarted = new OutboxRelay(relayUrl, rabbitPublisher)
  try {
    await restarted.flush()
    await waitFor(async () => {
      const message = await sink.get(`${queue}.sink`, { noAck: true })
      if (!message) return null
      const envelope = JSON.parse(message.content.toString())
      return envelope.tenantId === fixture.tenantId ? envelope : null
    })
  } finally {
    await restarted.close()
    await rabbitPublisher.close()
  }
  expect(
    await administrator`select id from outbox
      where tenant_id = ${fixture.tenantId} and dispatched_at is null`,
  ).toHaveLength(0)
})
