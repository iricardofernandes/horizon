import { randomBytes, randomUUID } from 'node:crypto'
import { type Channel, type ChannelModel, connect } from 'amqplib'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ProvisionTenantCatalogUseCase } from '@/application/use-cases/provision-tenant-catalog'
import { CatalogDatabase } from '@/infrastructure/database/drizzle/catalog-database'
import { RabbitMqEventConsumer } from '@/infrastructure/messaging/event-consumer'

const clock = { now: () => new Date() }
let database: CatalogDatabase
let owner: ReturnType<typeof postgres>
let consumer: RabbitMqEventConsumer
let broker: ChannelModel
let publisher: Channel
let deadLetters: Channel
const queue = 'catalog.events'

beforeAll(async () => {
  database = new CatalogDatabase({ url: process.env.DATABASE_URL ?? '' })
  owner = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  broker = await connect(process.env.RABBITMQ_URL ?? '')
  publisher = await broker.createChannel()
  deadLetters = await broker.createChannel()
  const provision = new ProvisionTenantCatalogUseCase(database, clock, {
    priceListCurrency: 'BRL',
  })
  consumer = new RabbitMqEventConsumer({
    url: process.env.RABBITMQ_URL ?? '',
    prefetch: 5,
    handlers: {
      'identity.tenant.created': async (event) => {
        const result = await provision.execute({
          tenantId: event.tenantId,
          event: {
            sourceModule: 'identity',
            eventId: event.eventId,
            eventType: event.eventType,
          },
        })
        if (result.isLeft()) throw result.value
      },
    },
  })
  await consumer.start()
})

afterAll(async () => {
  await consumer?.onModuleDestroy()
  // Channels first, then the connection that carries them: closing both at once leaves a
  // channel waiting for a close-ok the destroyed socket will never deliver.
  await Promise.allSettled([publisher?.close(), deadLetters?.close()])
  await Promise.allSettled([broker?.close(), database?.close(), owner?.end()])
})

function tenantCreated(tenantId: string, overrides: Record<string, unknown> = {}) {
  return {
    eventId: randomUUID(),
    eventType: 'identity.tenant.created',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload: {
      tenantId,
      name: 'Consumed Tenant',
      timezone: 'America/Sao_Paulo',
      createdAt: new Date().toISOString(),
    },
    ...overrides,
  }
}

function publish(event: Record<string, unknown>): void {
  publisher.publish(
    'horizon.events',
    String(event.eventType ?? 'identity.tenant.created'),
    Buffer.from(JSON.stringify(event)),
    { persistent: true, contentType: 'application/json', messageId: String(event.eventId) },
  )
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the consumer')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function unitsOf(tenantId: string) {
  const rows =
    await owner`select code from units_of_measure where tenant_id = ${tenantId} order by code`
  return rows.map((row) => String(row.code))
}

async function nextDeadLetter(messageId: string) {
  return waitFor(async () => {
    const message = await deadLetters.get(`${queue}.dlq`, { noAck: true })
    if (message === false) return null
    return message.properties.messageId === messageId ? message : null
  })
}

it('provisions a tenant catalogue from the published event, exactly once', async () => {
  const tenantId = randomUUID()
  const event = tenantCreated(tenantId)
  publish(event)

  await waitFor(async () => {
    const codes = await unitsOf(tenantId)
    return codes.length === 4 ? codes : null
  })
  expect(await unitsOf(tenantId)).toEqual(['H', 'KG', 'L', 'UN'])
  const lists = await owner`select name, currency from price_lists where tenant_id = ${tenantId}`
  expect(lists[0]).toMatchObject({ name: 'Base', currency: 'BRL' })

  // The same event again: the broker is entitled to redeliver, the effect is not.
  publish(event)
  publish(tenantCreated(tenantId))
  await waitFor(async () => {
    const rows = await owner`select count(*)::int as total from inbox where tenant_id = ${tenantId}`
    return rows[0]?.total === 2 ? rows : null
  })
  expect(await unitsOf(tenantId)).toEqual(['H', 'KG', 'L', 'UN'])
  const inbox = await owner`select event_id from inbox where tenant_id = ${tenantId}`
  expect(inbox).toHaveLength(2)
  const priceLists = await owner`select id from price_lists where tenant_id = ${tenantId}`
  expect(priceLists).toHaveLength(1)
})

it('dead-letters a message it can never understand instead of retrying it forever', async () => {
  const tenantId = randomUUID()
  const malformed = tenantCreated(tenantId, { payload: { tenantId, name: '' } })
  publish(malformed)
  const dead = await nextDeadLetter(String(malformed.eventId))
  expect(JSON.parse(dead.content.toString()).eventId).toBe(malformed.eventId)
  expect(await unitsOf(tenantId)).toEqual([])

  // An event version this module has no contract for is the same kind of verdict.
  const unknown = tenantCreated(randomUUID(), { eventVersion: 99 })
  publish(unknown)
  expect(
    JSON.parse((await nextDeadLetter(String(unknown.eventId))).content.toString()),
  ).toMatchObject({ eventVersion: 99 })
})

it('retries a failing handler once and then dead-letters it', async () => {
  const attempts: string[] = []
  const failing = new RabbitMqEventConsumer({
    url: process.env.RABBITMQ_URL ?? '',
    queue: `catalog.failing-${randomBytes(4).toString('hex')}`,
    handlers: {
      'identity.tenant.created': async (event) => {
        attempts.push(event.eventId)
        throw new Error('the database is unreachable')
      },
    },
  })
  await failing.start()
  const failingQueue = (failing as unknown as { options: { queue: string } }).options.queue
  try {
    const event = tenantCreated(randomUUID())
    publish(event)
    await waitFor(async () => (attempts.length === 2 ? attempts : null))
    // Exactly two attempts: the original delivery and one redelivery. Then it stops.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(attempts).toEqual([event.eventId, event.eventId])
    const dead = await waitFor(async () => {
      const message = await deadLetters.get(`${failingQueue}.dlq`, { noAck: true })
      return message === false ? null : message
    })
    expect(JSON.parse(dead.content.toString()).eventId).toBe(event.eventId)
  } finally {
    await failing.onModuleDestroy()
  }
})
