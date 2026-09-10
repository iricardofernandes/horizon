import { type EventEnvelope, eventEnvelopeSchema, findEvent } from '@horizon/contracts'
import { metrics } from '@opentelemetry/api'
import postgres from 'postgres'

export interface EventPublisher {
  publish(event: EventEnvelope, traceParent?: string): Promise<void>
}

const meter = metrics.getMeter('identity.outbox')
const delivered = meter.createCounter('outbox_published_total')
const failed = meter.createCounter('outbox_publish_failures_total')
const lag = meter.createGauge('outbox_lag_seconds')

/** At least once: a crash after broker confirm but before commit can redeliver (ADR 0024). */
export class OutboxRelay {
  readonly #client: ReturnType<typeof postgres>

  constructor(
    url: string,
    private readonly publisher: EventPublisher,
    private readonly batchSize = 100,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
      throw new Error('Invalid outbox batch size')
    this.#client = postgres(url, {
      max: 1,
      connect_timeout: 5,
      connection: { statement_timeout: 5000 },
    })
  }

  async flush(): Promise<number> {
    const outcome = await this.#client.begin(async (tx) => {
      const rows =
        await tx`select * from outbox where dispatched_at is null order by created_at, id limit ${this.batchSize} for update skip locked`
      const [backlog] =
        await tx`select extract(epoch from now() - min(created_at)) as age from outbox where dispatched_at is null`
      lag.record(Number(backlog?.age ?? 0))
      let published = 0
      for (const row of rows) {
        try {
          await this.dispatch(row)
        } catch (error) {
          await tx`update outbox set attempts = least(attempts + 1, 32767), last_error = 'Delivery failed; see relay telemetry' where id = ${row.id}`
          failed.add(1)
          return { published, error }
        }
        await tx`update outbox set dispatched_at = now(), attempts = least(attempts + 1, 32767), last_error = null where id = ${row.id}`
        delivered.add(1, { event_type: String(row.event_type) })
        published += 1
      }
      return { published, error: null }
    })
    if (outcome.error) throw outcome.error
    return outcome.published
  }

  private async dispatch(row: postgres.Row): Promise<void> {
    const event = eventEnvelopeSchema.parse({
      eventId: row.event_id,
      tenantId: row.tenant_id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      occurredAt: new Date(row.occurred_at).toISOString(),
      traceId: row.trace_id,
      payload: row.payload,
    })
    const definition = findEvent(event.eventType, event.eventVersion)
    if (!definition) throw new Error('Unknown outbox contract')
    definition.payload.parse(event.payload)
    await this.publisher.publish(event, row.trace_parent ?? undefined)
  }

  async close(): Promise<void> {
    await this.#client.end({ timeout: 5 })
  }
}
