import { randomUUID } from 'node:crypto'
import { REPORTING_REPLAY_QUEUE } from '@horizon/contracts'
import { connect } from 'amqplib'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JOURNALED_EVENT_TYPES, JournalIntake } from '@/application/journal-intake'
import { JournalEventUseCase } from '@/application/use-cases/journal-event'
import { ReportingDatabase } from '@/infrastructure/database/drizzle/reporting-database'
import { QueueConsumer } from '@/infrastructure/messaging/queue-consumer'

/**
 * The reporting journal against real PostgreSQL and RabbitMQ (ADR 0058, Phase 61).
 */
const clock = { now: () => new Date() }
let database: ReportingDatabase
let intake: JournalIntake
let application: ReturnType<typeof postgres>
/** The superuser: reads what RLS hides from the application and tries what triggers forbid. */
let administrator: ReturnType<typeof postgres>

beforeAll(() => {
  database = new ReportingDatabase({ url: process.env.DATABASE_URL ?? '' })
  intake = new JournalIntake(database, clock)
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), application?.end(), administrator?.end()])
})

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

function event(tenantId: string, occurredAt: Date, eventType = 'catalog.item.deactivated') {
  return {
    eventId: randomUUID(),
    tenantId,
    eventType,
    eventVersion: 1,
    occurredAt: occurredAt.toISOString(),
    traceId: 'b'.repeat(32),
    payload: { itemId: randomUUID() },
  }
}

function seal(tenantId: string, through: Date, count: number, source = 'catalog') {
  return {
    kind: 'seal',
    sealId: randomUUID(),
    source,
    tenantId,
    through: through.toISOString(),
    count,
    sealedAt: new Date().toISOString(),
  }
}

async function catalogState(tenantId: string) {
  const states = await database.sources(tenantId)
  const state = states.find((candidate) => candidate.source === 'catalog')
  if (!state) throw new Error('catalog is a journaled source')
  return state
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('condition not reached in time')
}

describe('the journal', () => {
  it('keeps each event once, whatever the order and however often it arrives', async () => {
    const tenantId = randomUUID()
    const first = event(tenantId, minutesAgo(30))
    const second = event(tenantId, minutesAgo(20))
    expect(await intake.live(second)).toBe('journaled')
    expect(await intake.live(first)).toBe('journaled')
    expect(await intake.live(second)).toBe('duplicate')
    expect(await intake.replay(first)).toBe('duplicate')
    const rows = await administrator`
      select event_id, arrival from event_journal where tenant_id = ${tenantId} order by occurred_at`
    expect(rows.map((row) => row.event_id)).toEqual([first.eventId, second.eventId])
    expect(rows.every((row) => row.arrival === 'live')).toBe(true)
  })

  it('stores a procurement payload without the supplier name', async () => {
    const tenantId = randomUUID()
    const journal = new JournalEventUseCase(database)
    const received = {
      ...event(tenantId, minutesAgo(5), 'procurement.order.placed'),
      payload: { orderId: randomUUID(), supplierName: 'Maria Silva' },
    }
    expect(await journal.execute(received, 'replay')).toBe('journaled')
    const [row] = await administrator`
      select payload from event_journal where event_id = ${received.eventId}`
    expect(row?.payload).toEqual({ orderId: received.payload.orderId })
  })

  it('moves the watermark only on a matching seal, and settles cutoffs behind it', async () => {
    const tenantId = randomUUID()
    await intake.live(event(tenantId, minutesAgo(40)))
    await intake.replay(event(tenantId, minutesAgo(30)))
    await intake.live(event(tenantId, minutesAgo(1)))

    expect(await intake.replay(seal(tenantId, minutesAgo(10), 3))).toMatchObject({
      outcome: 'mismatched',
      journalCount: 2,
    })
    expect((await catalogState(tenantId)).watermark).toBeNull()

    const through = minutesAgo(10)
    expect(await intake.replay(seal(tenantId, through, 2))).toMatchObject({ outcome: 'matched' })
    const state = await catalogState(tenantId)
    expect(state).toMatchObject({
      events: 3,
      lastSeal: { producerCount: 2, journalCount: 2, outcome: 'matched' },
    })
    expect(state.watermark?.toISOString()).toBe(through.toISOString())

    // An earlier seal never moves the watermark back.
    await intake.replay(seal(tenantId, minutesAgo(35), 1))
    expect((await catalogState(tenantId)).watermark?.toISOString()).toBe(through.toISOString())
  })

  it('refuses to rewrite history, and a watermark never moves back', async () => {
    const tenantId = randomUUID()
    await intake.live(event(tenantId, minutesAgo(30)))
    await intake.replay(seal(tenantId, minutesAgo(10), 1))
    await expect(administrator`update event_journal set payload = '{}'`).rejects.toThrow(
      /append-only/,
    )
    await expect(administrator`delete from event_journal`).rejects.toThrow(/append-only/)
    await expect(administrator`delete from source_seals`).rejects.toThrow(/append-only/)
    await expect(
      administrator`update source_watermarks set through = through - interval '1 hour'
        where tenant_id = ${tenantId}`,
    ).rejects.toThrow(/never moves back/)
    await expect(
      application.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${tenantId}, true)`
        await tx`update event_journal set arrival = 'replay'`
      }),
    ).rejects.toThrow(/permission denied/)
  })

  it('shows a tenant nothing of another', async () => {
    const tenantId = randomUUID()
    const otherTenant = randomUUID()
    await intake.live(event(tenantId, minutesAgo(30)))
    await intake.replay(seal(tenantId, minutesAgo(10), 1))
    expect(await catalogState(otherTenant)).toMatchObject({
      events: 0,
      watermark: null,
      lastSeal: null,
    })
    const leaked = await application.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${otherTenant}, true)`
      return tx`select
        (select count(*) from event_journal where tenant_id = ${tenantId})::int as events,
        (select count(*) from source_seals where tenant_id = ${tenantId})::int as seals,
        (select count(*) from source_watermarks where tenant_id = ${tenantId})::int as watermarks`
    })
    expect(leaked[0]).toEqual({ events: 0, seals: 0, watermarks: 0 })
  })
})

describe('the queues', () => {
  const tenantId = randomUUID()
  let live: QueueConsumer
  let replay: QueueConsumer

  beforeAll(async () => {
    const url = process.env.RABBITMQ_URL ?? ''
    live = new QueueConsumer({
      url,
      queue: 'reporting.events',
      bindings: JOURNALED_EVENT_TYPES,
      handle: (body) => intake.live(body),
      prefetch: 20,
    })
    replay = new QueueConsumer({
      url,
      queue: REPORTING_REPLAY_QUEUE,
      bindings: [],
      handle: async (body) => {
        const outcome = await intake.replay(body)
        return typeof outcome === 'string' ? outcome : `seal-${outcome.outcome}`
      },
      prefetch: 1,
    })
    await Promise.all([live.start(), replay.start()])
  })

  afterAll(async () => {
    await Promise.allSettled([live?.close(), replay?.close()])
  })

  it('journals the live flow, a replay through the default exchange, and its seal', async () => {
    const connection = await connect(process.env.RABBITMQ_URL ?? '')
    try {
      const channel = await connection.createConfirmChannel()
      const publish = async (exchange: string, key: string, body: unknown) => {
        channel.publish(exchange, key, Buffer.from(JSON.stringify(body)), { persistent: true })
        await channel.waitForConfirms()
      }
      const liveEvent = event(tenantId, minutesAgo(20))
      await publish('horizon.events', liveEvent.eventType, liveEvent)
      await eventually(
        () => catalogState(tenantId),
        (state) => state.events === 1,
      )

      // The producer resends its history, the live event included, then seals it.
      const older = event(tenantId, minutesAgo(30))
      await publish('', REPORTING_REPLAY_QUEUE, older)
      await publish('', REPORTING_REPLAY_QUEUE, liveEvent)
      await publish('', REPORTING_REPLAY_QUEUE, seal(tenantId, minutesAgo(10), 2))
      const state = await eventually(
        () => catalogState(tenantId),
        (candidate) => candidate.watermark !== null,
      )
      expect(state).toMatchObject({ events: 2, lastSeal: { outcome: 'matched' } })

      // What no retry can fix goes to the dead-letter queue at once.
      await publish('horizon.events', 'catalog.item.deactivated', { not: 'an envelope' })
      await eventually(
        async () => (await channel.checkQueue('reporting.events.dlq')).messageCount,
        (count) => count === 1,
      )
    } finally {
      await connection.close()
    }
  })
})
