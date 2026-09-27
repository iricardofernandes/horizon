import { randomUUID } from 'node:crypto'
import {
  type EventEnvelope,
  eventEnvelopeSchema,
  type JournalSeal,
  journalSealSchema,
  REPORTING_REPLAY_QUEUE,
} from '@horizon/contracts'
import { type ConfirmChannel, connect, type Message } from 'amqplib'
import type postgres from 'postgres'

/**
 * This module's history for `reporting/` alone (ADR 0058). Every outbox row of a tenant
 * is resent unchanged, with its event id, and a seal follows with the number of the
 * tenant's rows up to `through`. Reporting keeps the first copy of an event id, so a
 * second run changes nothing.
 */
export const JOURNAL_SOURCE = 'sales'
/** No transaction open now can still add a row this far back (ADR 0058). */
export const SEAL_MARGIN_MS = 120_000
const PAGE = 500
const CONFIRM_TIMEOUT_MS = 5000

export type ReplayMessage = EventEnvelope | JournalSeal
export type Deliver = (messageId: string, message: ReplayMessage) => Promise<void>

export interface JournalReplayOptions {
  readonly tenantId: string
  readonly since: Date | null
  readonly until: Date | null
  readonly sealOnly: boolean
  readonly now: Date
}

export interface JournalReplayResult {
  readonly sent: number
  readonly seal: JournalSeal
}

/** The bound, never inside the margin. */
export function throughOf(until: Date | null, now: Date): Date {
  const latest = new Date(now.getTime() - SEAL_MARGIN_MS)
  const through = until ?? latest
  if (through.getTime() > latest.getTime())
    throw new Error(`--until must be at least ${SEAL_MARGIN_MS / 1000}s in the past`)
  return through
}

function envelopeOf(row: postgres.Row): EventEnvelope {
  return eventEnvelopeSchema.parse({
    eventId: row.event_id,
    tenantId: row.tenant_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    occurredAt: new Date(row.occurred_at).toISOString(),
    traceId: row.trace_id,
    payload: row.payload,
  })
}

/**
 * Reads as the relay role, which sees every tenant's outbox; the tenant filter is this
 * function's own. Instants compare at the millisecond an envelope carries.
 */
async function resend(
  sql: postgres.Sql,
  deliver: Deliver,
  tenantId: string,
  since: Date,
  through: Date,
): Promise<number> {
  let sent = 0
  let after: { at: Date; id: string } | null = null
  for (;;) {
    const cursor: { at: Date; id: string } | null = after
    const rows: postgres.Row[] = await sql`
      select * from outbox
      where tenant_id = ${tenantId}
        and date_trunc('milliseconds', occurred_at) > ${since}
        and date_trunc('milliseconds', occurred_at) <= ${through}
        ${cursor ? sql`and (occurred_at, id) > (${cursor.at}, ${cursor.id})` : sql``}
      order by occurred_at, id
      limit ${PAGE}`
    for (const row of rows) {
      const event = envelopeOf(row)
      await deliver(event.eventId, event)
      sent += 1
    }
    const last = rows.at(-1)
    if (!last || rows.length < PAGE) return sent
    after = { at: last.occurred_at as Date, id: String(last.id) }
  }
}

export async function replayJournal(
  sql: postgres.Sql,
  deliver: Deliver,
  options: JournalReplayOptions,
): Promise<JournalReplayResult> {
  const through = throughOf(options.until, options.now)
  const sent = options.sealOnly
    ? 0
    : await resend(sql, deliver, options.tenantId, options.since ?? new Date(0), through)
  const [row] = await sql`
    select count(*)::int as count from outbox
    where tenant_id = ${options.tenantId}
      and date_trunc('milliseconds', occurred_at) <= ${through}`
  const seal = journalSealSchema.parse({
    kind: 'seal',
    sealId: randomUUID(),
    source: JOURNAL_SOURCE,
    tenantId: options.tenantId,
    through: through.toISOString(),
    count: Number(row?.count ?? 0),
    sealedAt: new Date().toISOString(),
  })
  await deliver(seal.sealId, seal)
  return { sent, seal }
}

/** Publishes to the reporting replay queue through the default exchange, confirmed. */
export async function openReplayQueue(
  url: string,
): Promise<{ deliver: Deliver; close: () => Promise<void> }> {
  const connection = await connect(url, { timeout: CONFIRM_TIMEOUT_MS })
  const channel = await connection.createConfirmChannel()
  return {
    deliver: (messageId, message) => confirm(channel, messageId, message),
    close: () => connection.close(),
  }
}

function confirm(channel: ConfirmChannel, messageId: string, body: ReplayMessage): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error | null) => {
      clearTimeout(timer)
      channel.off('return', returned)
      if (error) reject(error)
      else resolve()
    }
    const returned = (message: Message) => {
      if (message.properties.messageId === messageId)
        finish(new Error(`${REPORTING_REPLAY_QUEUE} does not exist; is reporting running?`))
    }
    const timer = setTimeout(
      () => finish(new Error('Publish confirmation timed out')),
      CONFIRM_TIMEOUT_MS,
    )
    channel.on('return', returned)
    channel.publish(
      '',
      REPORTING_REPLAY_QUEUE,
      Buffer.from(JSON.stringify(body)),
      { mandatory: true, persistent: true, contentType: 'application/json', messageId },
      finish,
    )
  })
}
