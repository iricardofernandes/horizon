import { randomBytes, randomUUID } from 'node:crypto'
import { trace } from '@opentelemetry/api'
import { NodeSDK, tracing } from '@opentelemetry/sdk-node'
import { type Channel, type ChannelModel, connect } from 'amqplib'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { CreateCatalogItemUseCase } from '@/application/use-cases/create-catalog-item'
import { CreateUnitUseCase } from '@/application/use-cases/create-unit'
import { CatalogDatabase } from '@/infrastructure/database/drizzle/catalog-database'
import { OutboxRelay } from '@/infrastructure/messaging/outbox-relay'
import { RabbitMqEventPublisher } from '@/infrastructure/messaging/rabbitmq-event-publisher'

const spans = new tracing.InMemorySpanExporter()
const telemetry = new NodeSDK({
  spanProcessors: [new tracing.SimpleSpanProcessor(spans)],
  logRecordProcessors: [],
  metricReaders: [],
})
const clock = { now: () => new Date() }
const actor = { type: 'user', id: randomUUID() } as const
let database: CatalogDatabase
let owner: ReturnType<typeof postgres>
let first: OutboxRelay
let second: OutboxRelay
let publisher: RabbitMqEventPublisher
let broker: ChannelModel
let consumer: Channel
let queue: string
let relayUrl: string

beforeAll(async () => {
  telemetry.start()
  owner = postgres(process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_MIGRATION_URL ?? '')
  await owner`alter role horizon_relay login password 'test'`
  const url = new URL(process.env.DATABASE_URL ?? '')
  url.username = 'horizon_relay'
  url.password = 'test'
  relayUrl = url.toString()
  database = new CatalogDatabase({ url: process.env.DATABASE_URL ?? '' })
  publisher = await RabbitMqEventPublisher.open(process.env.RABBITMQ_URL ?? '')
  broker = await connect(process.env.RABBITMQ_URL ?? '')
  consumer = await broker.createChannel()
  queue = (await consumer.assertQueue('', { exclusive: true })).queue
  await consumer.bindQueue(queue, 'horizon.events', 'catalog.#')
  first = new OutboxRelay(relayUrl, publisher, 2)
  second = new OutboxRelay(relayUrl, publisher, 2)
})

afterAll(async () => {
  await Promise.allSettled([
    first?.close(),
    second?.close(),
    publisher?.close(),
    broker?.close(),
    database?.close(),
    owner?.end(),
  ])
  await telemetry.shutdown()
})

/** Each call produces `count` `catalog.item.created` rows under a fresh tenant. */
async function enqueue(count: number) {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const unit = await new CreateUnitUseCase(database, clock).execute({
    actor,
    tenantId,
    code: 'UN',
    name: 'Unit',
    decimalPlaces: 0,
  })
  if (unit.isLeft()) throw unit.value
  for (let index = 0; index < count; index++) {
    const item = await new CreateCatalogItemUseCase(database, clock).execute({
      actor,
      tenantId,
      kind: 'product',
      sku: `SKU-${index}-${randomBytes(4).toString('hex')}`,
      name: 'Coffee',
      unitId: unit.value.unitId,
      ncm: '09012100',
    })
    if (item.isLeft()) throw item.value
  }
  return tenantId
}

async function drain() {
  const events: { eventId: string; tenantId: string; eventType: string }[] = []
  for (;;) {
    const message = await consumer.get(queue, { noAck: true })
    if (!message) return events
    expect(message.properties.deliveryMode).toBe(2)
    events.push(JSON.parse(message.content.toString()))
  }
}

it('two concurrent relays deliver every row once in a successful run', async () => {
  const tenantId = await enqueue(7)
  for (let round = 0; round < 3; round++) await Promise.all([first.flush(), second.flush()])
  const events = (await drain()).filter((event) => event.tenantId === tenantId)
  expect(events).toHaveLength(7)
  expect(new Set(events.map((event) => event.eventId)).size).toBe(7)
  expect(events.every((event) => event.eventType === 'catalog.item.created')).toBe(true)
  expect(
    await owner`select * from outbox where tenant_id = ${tenantId} and dispatched_at is null`,
  ).toHaveLength(0)
})

it('a publish failure leaves the row available for a restarted relay', async () => {
  const tenantId = await enqueue(1)
  const failing = new OutboxRelay(relayUrl, {
    publish: async () => {
      throw new Error('broker unavailable')
    },
  })
  try {
    await expect(failing.flush()).rejects.toThrow('broker unavailable')
  } finally {
    await failing.close()
  }
  expect(
    await owner`select * from outbox where tenant_id = ${tenantId} and dispatched_at is null`,
  ).toHaveLength(1)
  expect(await first.flush()).toBe(1)
  expect((await drain()).some((event) => event.tenantId === tenantId)).toBe(true)
})

it('the relay role cannot read catalog tables or modify audit records', async () => {
  const relay = postgres(relayUrl)
  try {
    await expect(relay`select * from catalog_items`).rejects.toThrow('permission denied')
    await expect(relay`select * from price_lists`).rejects.toThrow('permission denied')
    await expect(relay`select * from units_of_measure`).rejects.toThrow('permission denied')
    await expect(relay`update audit_log set action = 'forged'`).rejects.toThrow('permission denied')
  } finally {
    await relay.end()
  }
})

it('retains an unroutable event even when the broker confirms the publish', async () => {
  const tenantId = await enqueue(1)
  const unroutablePublisher = await RabbitMqEventPublisher.open(
    process.env.RABBITMQ_URL ?? '',
    `unbound-${randomBytes(8).toString('hex')}`,
  )
  const relay = new OutboxRelay(relayUrl, unroutablePublisher)
  try {
    await expect(relay.flush()).rejects.toThrow('no matching queue')
    const rows =
      await owner`select dispatched_at, attempts, last_error from outbox where tenant_id = ${tenantId}`
    expect(rows[0]).toMatchObject({ dispatched_at: null, attempts: 1 })
    expect(rows[0]?.last_error).not.toBeNull()
  } finally {
    await relay.close()
    await unroutablePublisher.close()
  }
})

it('preserves the request trace and parent across the durable outbox and broker', async () => {
  // Drain rows deliberately retained by the failure tests above.
  await first.flush()
  await drain()
  let requestTraceId = ''
  let requestSpanId = ''
  await trace.getTracer('catalog.test').startActiveSpan('test.request', async (span) => {
    requestTraceId = span.spanContext().traceId
    requestSpanId = span.spanContext().spanId
    try {
      await enqueue(1)
    } finally {
      span.end()
    }
  })
  await second.flush()
  const message = await consumer.get(queue, { noAck: true })
  if (!message) throw new Error('Missing broker message')
  const event = JSON.parse(message.content.toString())
  expect(event.traceId).toBe(requestTraceId)
  const publishSpan = spans
    .getFinishedSpans()
    .find((span) => span.name === 'outbox.publish' && span.spanContext().traceId === requestTraceId)
  expect(publishSpan?.parentSpanContext?.spanId).toBe(requestSpanId)
  expect(message.properties.headers?.traceparent).toBe(
    `00-${requestTraceId}-${publishSpan?.spanContext().spanId}-01`,
  )
})
