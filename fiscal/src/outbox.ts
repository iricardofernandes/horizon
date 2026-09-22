import { createHash } from 'node:crypto'
import { eventEnvelopeSchema, findEvent } from '@horizon/contracts'
import { type ChannelModel, type ConfirmChannel, connect } from 'amqplib'
import postgres from 'postgres'
import { z } from 'zod'

/** Publishes committed simulation facts with confirms; a crash can redeliver one event ID. */
export class FiscalOutboxRelay {
  readonly #db: ReturnType<typeof postgres>
  #connection: ChannelModel | null = null
  #channel: ConfirmChannel | null = null
  #channelPromise: Promise<ConfirmChannel> | null = null

  constructor(
    databaseUrl: string,
    private readonly brokerUrl: string,
  ) {
    this.#db = postgres(databaseUrl, { max: 2, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#channel?.close()
    await this.#connection?.close()
    await this.#db.end()
  }

  async flush(tenantId: string): Promise<number> {
    z.uuid().parse(tenantId)
    const channel = await this.channel()
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const rows = await tx`select event_id, event_type, payload, created_at
        from fiscal_outbox where tenant_id = ${tenantId} and delivered_at is null
        order by created_at, event_id limit 50`
      for (const row of rows) {
        const definition = findEvent(String(row.event_type), 1)
        if (!definition) throw new Error('Unknown Fiscal outbox event contract')
        const payload = definition.payload.parse(row.payload)
        const envelope = eventEnvelopeSchema.parse({
          eventId: String(row.event_id),
          eventType: String(row.event_type),
          eventVersion: 1,
          occurredAt: z.iso.datetime().parse((payload as { observedAt: string }).observedAt),
          tenantId,
          traceId: createHash('sha256').update(String(row.event_id)).digest('hex').slice(0, 32),
          payload,
        })
        channel.publish(
          'horizon.events',
          envelope.eventType,
          Buffer.from(JSON.stringify(envelope)),
          {
            persistent: true,
            contentType: 'application/json',
            messageId: envelope.eventId,
            headers: { 'x-trace-id': envelope.traceId },
          },
        )
        await channel.waitForConfirms()
        await tx`update fiscal_outbox set delivered_at = now()
          where tenant_id = ${tenantId} and event_id = ${row.event_id}
            and delivered_at is null`
      }
      return rows.length
    })
  }

  private async channel(): Promise<ConfirmChannel> {
    if (this.#channel) return this.#channel
    if (this.#channelPromise) return this.#channelPromise
    this.#channelPromise = this.connectChannel()
    try {
      return await this.#channelPromise
    } catch (error) {
      this.#channelPromise = null
      throw error
    }
  }

  private async connectChannel(): Promise<ConfirmChannel> {
    this.#connection = await connect(this.brokerUrl, { timeout: 5000 })
    this.#channel = await this.#connection.createConfirmChannel()
    await this.#channel.assertExchange('horizon.events', 'topic', { durable: true })
    return this.#channel
  }
}
