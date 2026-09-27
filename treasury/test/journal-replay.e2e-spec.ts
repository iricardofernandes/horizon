import { randomUUID } from 'node:crypto'
import type { EventEnvelope, JournalSeal } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  JOURNAL_SOURCE,
  type ReplayMessage,
  replayJournal,
} from '@/infrastructure/messaging/journal-replay'

/**
 * `republish:journal` (ADR 0058, Phase 61): every outbox row of one tenant, once, in
 * order, then a seal with the tenant's count; nothing of another tenant.
 */
const EVENT_TYPE = 'treasury.account.opened'
let admin: postgres.Sql
let relay: postgres.Sql

async function outboxRow(tenantId: string, occurredAt: Date): Promise<string> {
  const eventId = randomUUID()
  await admin.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    await tx`insert into tenants (id) values (${tenantId}) on conflict do nothing`
    await tx`insert into outbox (id, tenant_id, event_id, event_type, event_version, occurred_at, trace_id, payload)
      values (${randomUUID()}, ${tenantId}, ${eventId}, ${EVENT_TYPE}, 1, ${occurredAt}, ${'0'.repeat(32)}, ${tx.json({ replayed: true })})`
  })
  return eventId
}

function collector() {
  const messages: ReplayMessage[] = []
  return {
    messages,
    deliver: async (_id: string, message: ReplayMessage) => {
      messages.push(message)
    },
  }
}

describe('republish:journal', () => {
  const tenantId = randomUUID()
  const otherTenant = randomUUID()
  const now = new Date()
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000)
  const ids: string[] = []

  beforeAll(async () => {
    admin = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
    relay = postgres(
      (process.env.DATABASE_URL ?? '').replace(/\/\/[^:]+:[^@]+@/, '//horizon_relay:test@'),
      { max: 1 },
    )
    ids.push(await outboxRow(tenantId, minutesAgo(30)))
    ids.push(await outboxRow(tenantId, minutesAgo(20)))
    ids.push(await outboxRow(tenantId, minutesAgo(10)))
    await outboxRow(tenantId, minutesAgo(1))
    await outboxRow(otherTenant, minutesAgo(15))
  })

  afterAll(async () => {
    await Promise.allSettled([admin?.end(), relay?.end()])
  })

  it('sends the tenant rows in order, then a seal that counts them up to the bound', async () => {
    const sink = collector()
    const result = await replayJournal(relay, sink.deliver, {
      tenantId,
      since: null,
      until: null,
      sealOnly: false,
      now,
    })
    const events = sink.messages.slice(0, -1) as EventEnvelope[]
    const seal = sink.messages.at(-1) as JournalSeal
    // The row one minute old is inside the margin: neither sent nor counted.
    expect(events.map((event) => event.eventId)).toEqual(ids)
    expect(events.every((event) => event.tenantId === tenantId)).toBe(true)
    expect(seal).toMatchObject({ kind: 'seal', source: JOURNAL_SOURCE, tenantId, count: 3 })
    expect(result.sent).toBe(3)
  })

  it('resends a range and seals only when asked to', async () => {
    const range = collector()
    await replayJournal(relay, range.deliver, {
      tenantId,
      since: minutesAgo(25),
      until: minutesAgo(5),
      sealOnly: false,
      now,
    })
    expect(range.messages.slice(0, -1).map((event) => (event as EventEnvelope).eventId)).toEqual(
      ids.slice(1),
    )
    const sealOnly = collector()
    const result = await replayJournal(relay, sealOnly.deliver, {
      tenantId,
      since: null,
      until: minutesAgo(15),
      sealOnly: true,
      now,
    })
    expect(sealOnly.messages).toHaveLength(1)
    expect(result).toMatchObject({ sent: 0, seal: { count: 2 } })
  })

  it('refuses a bound inside the margin', async () => {
    await expect(
      replayJournal(relay, collector().deliver, {
        tenantId,
        since: null,
        until: minutesAgo(1),
        sealOnly: true,
        now,
      }),
    ).rejects.toThrow(/in the past/)
  })
})
