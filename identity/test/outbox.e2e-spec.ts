import { randomBytes } from 'node:crypto'
import { trace } from '@opentelemetry/api'
import { NodeSDK, tracing } from '@opentelemetry/sdk-node'
import { type Channel, type ChannelModel, connect } from 'amqplib'
import postgres from 'postgres'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { Tenant } from '@/domain/entities/tenant'
import { TenantCreatedEvent } from '@/domain/events/tenant-created-event'
import { TenantName } from '@/domain/value-objects/tenant-name'
import { TenantSlug } from '@/domain/value-objects/tenant-slug'
import { Timezone } from '@/domain/value-objects/timezone'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { IdentityDatabase } from '@/infrastructure/database/drizzle/identity-database'
import { OutboxRelay } from '@/infrastructure/messaging/outbox-relay'
import { RabbitMqEventPublisher } from '@/infrastructure/messaging/rabbitmq-event-publisher'

const spans = new tracing.InMemorySpanExporter()
const telemetry = new NodeSDK({
  spanProcessors: [new tracing.SimpleSpanProcessor(spans)],
  logRecordProcessors: [],
  metricReaders: [],
})
let db: IdentityDatabase
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
  db = new IdentityDatabase({
    url: process.env.DATABASE_URL ?? '',
    secretBox: new AesGcmSecretBox(),
    blindIndexKey: randomBytes(32),
  })
  publisher = await RabbitMqEventPublisher.open(process.env.RABBITMQ_URL ?? '')
  broker = await connect(process.env.RABBITMQ_URL ?? '')
  consumer = await broker.createChannel()
  queue = (await consumer.assertQueue('', { exclusive: true })).queue
  await consumer.bindQueue(queue, 'horizon.events', 'identity.#')
  first = new OutboxRelay(relayUrl, publisher, 2)
  second = new OutboxRelay(relayUrl, publisher, 2)
})
afterAll(async () => {
  await Promise.allSettled([
    first?.close(),
    second?.close(),
    publisher?.close(),
    broker?.close(),
    db?.close(),
    owner?.end(),
  ])
})

async function enqueue(count: number) {
  const tenantId = new UniqueEntityID().toString()
  const name = TenantName.create('Test')
  const slug = TenantSlug.create(`test-${randomBytes(6).toString('hex')}`)
  const timezone = Timezone.create('UTC')
  if (name.isLeft() || slug.isLeft() || timezone.isLeft()) throw new Error('Invalid tenant fixture')
  await db.inTenant(tenantId, async (scope) => {
    await scope.tenants.create(
      Tenant.create(
        { name: name.value, slug: slug.value, timezone: timezone.value },
        new UniqueEntityID(tenantId),
      ),
    )
    for (let index = 0; index < count; index++)
      await scope.outbox.publish([
        new TenantCreatedEvent(new UniqueEntityID(), tenantId, 'Test', 'UTC', new Date()),
      ])
  })
  return tenantId
}

it('two concurrent relays deliver every row once in a successful run', async () => {
  const tenantId = await enqueue(7)
  for (let round = 0; round < 3; round++) await Promise.all([first.flush(), second.flush()])
  const events: { eventId: string; tenantId: string }[] = []
  for (;;) {
    const message = await consumer.get(queue, { noAck: true })
    if (!message) break
    expect(message.properties.deliveryMode).toBe(2)
    events.push(JSON.parse(message.content.toString()))
  }
  expect(events).toHaveLength(7)
  expect(new Set(events.map((event) => event.eventId)).size).toBe(7)
  expect(events.every((event) => event.tenantId === tenantId)).toBe(true)
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
  const message = await consumer.get(queue, { noAck: true })
  expect(message).not.toBe(false)
})

it('the relay role cannot read business tables or modify audit records', async () => {
  await enqueue(1)
  await first.flush()
  await consumer.get(queue, { noAck: true })
  const relay = postgres(relayUrl)
  try {
    await expect(relay`select * from users`).rejects.toThrow('permission denied')
    await expect(relay`select * from data_subject_keys`).rejects.toThrow('permission denied')
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

afterAll(async () => {
  await telemetry.shutdown()
})

it('preserves the request trace and parent across the durable outbox and broker', async () => {
  // Drain events deliberately retained by earlier failure tests.
  await first.flush()
  while (await consumer.get(queue, { noAck: true })) {
    /* drain */
  }
  let requestTraceId = ''
  let requestSpanId = ''
  await trace.getTracer('identity.test').startActiveSpan('test.request', async (span) => {
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
