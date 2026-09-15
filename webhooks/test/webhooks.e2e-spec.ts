import { randomUUID } from 'node:crypto'
import { connect } from 'amqplib'
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

async function waitFor(read: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await read())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for RabbitMQ delivery')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
