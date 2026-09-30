import { randomUUID } from 'node:crypto'
import {
  type EventEnvelope,
  eventEnvelopeSchema,
  type JournalSeal,
  journalSealSchema,
  REPORTING_REPLAY_QUEUE,
} from '@horizon/contracts'
import { Logger } from '@nestjs/common'
import { type ConfirmChannel, connect, type Message } from 'amqplib'
import postgres from 'postgres'

/**
 * This module's history for `reporting/` alone (ADR 0058). Every outbox row of a tenant
 * is resent unchanged, with its event id, and a seal follows with the number of the
 * tenant's rows up to `through`. Reporting keeps the first copy of an event id, so a
 * second run changes nothing.
 */
export const JOURNAL_SOURCE = 'ledger'
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

function sealOf(tenantId: string, through: Date, count: number): JournalSeal {
  return journalSealSchema.parse({
    kind: 'seal',
    sealId: randomUUID(),
    source: JOURNAL_SOURCE,
    tenantId,
    through: through.toISOString(),
    count,
    sealedAt: new Date().toISOString(),
  })
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
  const seal = sealOf(options.tenantId, through, Number(row?.count ?? 0))
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

/**
 * Seals every tenant this module knows, through the margin (Phase 62), so reporting's
 * cutoffs settle without anyone running a command. A tenant with no outbox rows is sealed
 * with a count of 0 (Phase 79): before, it was never sealed, and its watermark for this
 * source stayed behind. Returns the number of seals sent.
 */
export async function sealAllTenants(sql: postgres.Sql, deliver: Deliver, now: Date) {
  const through = throughOf(null, now)
  const rows = await sql`
    with counted as (
      select tenant_id, count(*) filter (
        where date_trunc('milliseconds', occurred_at) <= ${through})::int as count
      from outbox group by tenant_id
    ), known as (
      select id as tenant_id from tenants union select tenant_id from counted
    )
    select known.tenant_id, coalesce(counted.count, 0)::int as count
    from known left join counted using (tenant_id) order by known.tenant_id`
  for (const row of rows) {
    const seal = sealOf(String(row.tenant_id), through, Number(row.count))
    await deliver(seal.sealId, seal)
  }
  return rows.length
}

export interface JournalSealWorkerOptions {
  readonly databaseUrl: string
  readonly rabbitmqUrl: string
  readonly intervalMs: number
}

/**
 * Runs next to the outbox relay, as the relay role. A failure (reporting not running, the
 * broker down) is logged and tried again at the next interval; it never touches the relay.
 */
export class JournalSealWorker {
  private readonly logger = new Logger(JournalSealWorker.name)
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private stopped = false

  constructor(private readonly options: JournalSealWorkerOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 10_000)
      throw new Error('Journal seal interval must be at least 10s')
  }

  onModuleInit(): void {
    this.schedule()
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.pending = this.seal().finally(() => this.schedule())
    }, this.options.intervalMs)
  }

  private async seal(): Promise<void> {
    const sql = postgres(this.options.databaseUrl, {
      max: 1,
      connect_timeout: 5,
      connection: { statement_timeout: 30_000 },
    })
    let queue: Awaited<ReturnType<typeof openReplayQueue>> | undefined
    try {
      queue = await openReplayQueue(this.options.rabbitmqUrl)
      await sealAllTenants(sql, queue.deliver, new Date())
    } catch (error) {
      const kind = error instanceof Error ? error.name : 'unknown'
      this.logger.warn(`Journal seals were not sent (${kind}); retrying at the next interval`)
    } finally {
      await queue?.close().catch(() => undefined)
      await sql.end({ timeout: 5 })
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.pending
  }
}
