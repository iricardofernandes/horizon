import { randomUUID } from 'node:crypto'
import { connect } from 'amqplib'
import postgres from 'postgres'
import {
  CreateSubscriptionUseCase,
  ReplayDeliveryUseCase,
  WebhookDispatcher,
} from '@/application/webhook-service'
import type { WebhookEvent } from '@/domain/webhook'
import { WebhookDatabase } from '@/infrastructure/database/webhook-database'
import { WebhookEventConsumer } from '@/infrastructure/messaging/event-consumer'

const key = Buffer.alloc(32, 7)
const clock = { now: () => new Date() }

function event(tenantId: string): WebhookEvent {
  return {
    eventId: randomUUID(),
    tenantId,
    eventType: 'sales.order.confirmed',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    traceId: '0123456789abcdef0123456789abcdef',
    payload: {
      orderId: randomUUID(),
      orderVersion: 2,
      customerId: randomUUID(),
      reservationId: randomUUID(),
      confirmedAt: new Date().toISOString(),
      lines: [
        {
          lineId: randomUUID(),
          itemId: randomUUID(),
          quantity: '1',
          description: 'Coffee',
          unitPrice: { amount: '1250', currency: 'BRL' },
          lineTotal: { amount: '1250', currency: 'BRL' },
        },
      ],
      total: { amount: '1250', currency: 'BRL' },
    },
  }
}

describe('webhook persistence and transport', () => {
  let database: WebhookDatabase

  beforeEach(() => {
    database = new WebhookDatabase({
      appUrl: process.env.DATABASE_URL ?? '',
      workerUrl: process.env.DATABASE_RELAY_URL ?? '',
      encryptionKey: key,
    })
  })

  afterEach(() => database.close())

  it('keeps subscriptions isolated and schedules a duplicate event exactly once', async () => {
    const firstTenant = randomUUID()
    const secondTenant = randomUUID()
    await Promise.all([
      database.provisionTenant(firstTenant),
      database.provisionTenant(secondTenant),
    ])
    const created = await new CreateSubscriptionUseCase(database, clock).execute({
      tenantId: firstTenant,
      endpointUrl: 'https://example.test/hooks',
      eventTypes: ['sales.order.confirmed'],
    })
    expect(await database.listSubscriptions(secondTenant)).toEqual([])
    expect((await database.listSubscriptions(firstTenant))[0]?.id).toBe(created.subscriptionId)
    const incoming = event(firstTenant)
    expect(await database.recordEvent(incoming, new Date())).toBe(1)
    expect(await database.recordEvent(incoming, new Date())).toBe(0)
    expect(await database.listDeliveries(firstTenant)).toHaveLength(1)
  })

  it('persists attempts, dead-letters a permanent failure and replays it', async () => {
    let now = new Date('2026-09-14T12:00:00.000Z')
    const tenantId = randomUUID()
    await database.provisionTenant(tenantId)
    await new CreateSubscriptionUseCase(database, { now: () => now }).execute({
      tenantId,
      endpointUrl: 'https://example.test/hooks',
      eventTypes: ['sales.order.confirmed'],
    })
    await database.recordEvent(event(tenantId), now)
    const dispatcher = new WebhookDispatcher(
      database,
      { post: async () => ({ status: 503 }) },
      { now: () => now },
      { maxAttempts: 3, baseMs: 10, maxMs: 100, jitterRatio: 0 },
      { timeoutMs: 100, batchSize: 10, queueDepthAlert: 0 },
      () => 0.5,
    )
    const pressure = await dispatcher.flush()
    expect(pressure.overDepthLimit).toBe(true)
    now = new Date(now.getTime() + 10)
    await dispatcher.flush()
    now = new Date(now.getTime() + 20)
    await dispatcher.flush()
    const [delivery] = await database.listDeliveries(tenantId)
    expect(delivery).toMatchObject({ status: 'dead-letter', attemptCount: 3 })
    if (!delivery) throw new Error('Expected a dead-letter delivery')
    expect(await database.listAttempts(tenantId, delivery.id)).toHaveLength(3)
    await new ReplayDeliveryUseCase(database, { now: () => now }).execute({
      tenantId,
      deliveryId: delivery.id,
    })
    expect((await database.listDeliveries(tenantId))[0]).toMatchObject({
      status: 'pending',
      attemptCount: 0,
    })
  })

  it('consumes the confirmed-order contract through RabbitMQ', async () => {
    const tenantId = randomUUID()
    await database.provisionTenant(tenantId)
    await new CreateSubscriptionUseCase(database, clock).execute({
      tenantId,
      endpointUrl: 'https://example.test/hooks',
      eventTypes: ['sales.order.confirmed'],
    })
    const queue = `webhooks.e2e.${randomUUID()}`
    const consumer = new WebhookEventConsumer({
      url: process.env.RABBITMQ_URL ?? '',
      repository: database,
      queue,
    })
    await consumer.start()
    const connection = await connect(process.env.RABBITMQ_URL ?? '')
    const channel = await connection.createChannel()
    const incoming = event(tenantId)
    channel.publish('horizon.events', incoming.eventType, Buffer.from(JSON.stringify(incoming)), {
      persistent: true,
      messageId: incoming.eventId,
    })
    await waitFor(async () => (await database.listDeliveries(tenantId)).length === 1)
    await consumer.close()
    await channel.deleteQueue(queue)
    await channel.close()
    await connection.close()
  })
})

describe('workspaces never provisioned, and dead letters of their own (Phase 79)', () => {
  let database: WebhookDatabase

  beforeEach(() => {
    database = new WebhookDatabase({
      appUrl: process.env.DATABASE_URL ?? '',
      workerUrl: process.env.DATABASE_RELAY_URL ?? '',
      encryptionKey: key,
    })
  })

  afterEach(() => database.close())

  it('records an event of a workspace it never saw, once, under the module that produced it', async () => {
    const tenantId = randomUUID()
    const incoming = event(tenantId)
    expect(await database.recordEvent(incoming, new Date())).toBe(0)
    expect(await database.recordEvent(incoming, new Date())).toBe(0)
    const sql = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
    try {
      const rows = await sql.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${tenantId}, true)`
        return tx<
          { source_module: string }[]
        >`select source_module from inbox where event_id = ${incoming.eventId}`
      })
      expect(rows).toEqual([{ source_module: 'sales' }])
    } finally {
      await sql.end()
    }
  })

  it('takes back an event recorded before Phase 79 under the wrong module, without failing', async () => {
    // Until Phase 79 every event was claimed as 'sales'. One recorded then and redelivered now
    // passes the inbox under its real module, and must find itself already recorded.
    const tenantId = randomUUID()
    const incoming = event(tenantId)
    await database.recordEvent(incoming, new Date())
    const admin = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
    try {
      await admin`update inbox set source_module = 'legacy' where event_id = ${incoming.eventId}`
    } finally {
      await admin.end()
    }
    expect(await database.recordEvent(incoming, new Date())).toBe(0)
  })

  it('lets a workspace subscribe before any of its events arrived', async () => {
    const tenantId = randomUUID()
    const created = await new CreateSubscriptionUseCase(database, clock).execute({
      tenantId,
      endpointUrl: 'https://example.test/hooks',
      eventTypes: ['sales.order.confirmed'],
    })
    expect((await database.listSubscriptions(tenantId))[0]?.id).toBe(created.subscriptionId)
    expect(await database.recordEvent(event(tenantId), new Date())).toBe(1)
  })

  it('puts a refused event in the refusing queue’s DLQ only, never in another’s', async () => {
    const failing = `webhooks.e2e.failing.${randomUUID()}`
    const healthy = `webhooks.e2e.healthy.${randomUUID()}`
    const refuses = {
      recordEvent: async () => {
        throw new Error('refused on purpose')
      },
    } as unknown as WebhookDatabase
    const consumers = [
      new WebhookEventConsumer({
        url: process.env.RABBITMQ_URL ?? '',
        repository: refuses,
        queue: failing,
      }),
      new WebhookEventConsumer({
        url: process.env.RABBITMQ_URL ?? '',
        repository: database,
        queue: healthy,
      }),
    ]
    for (const consumer of consumers) await consumer.start()
    const connection = await connect(process.env.RABBITMQ_URL ?? '')
    const channel = await connection.createChannel()
    try {
      const incoming = event(randomUUID())
      channel.publish('horizon.events', incoming.eventType, Buffer.from(JSON.stringify(incoming)), {
        persistent: true,
        messageId: incoming.eventId,
      })
      await waitFor(async () => (await channel.checkQueue(`${failing}.dlq`)).messageCount === 1)
      // Give a wrong copy the time to arrive before saying it did not.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect((await channel.checkQueue(`${healthy}.dlq`)).messageCount).toBe(0)
      const dead = await channel.get(`${failing}.dlq`, { noAck: true })
      expect(dead === false ? undefined : dead.properties.headers?.['x-first-death-queue']).toBe(
        failing,
      )
    } finally {
      for (const consumer of consumers) await consumer.close()
      for (const queue of [failing, healthy]) {
        await channel.deleteQueue(queue)
        await channel.deleteQueue(`${queue}.dlq`)
      }
      await channel.close()
      await connection.close()
    }
  })
})

async function waitFor(read: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await read())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for RabbitMQ delivery')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
