import { type EventEnvelope, eventEnvelopeSchema, findEvent } from '@horizon/contracts'
import { Logger } from '@nestjs/common'
import {
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import { type Channel, type ChannelModel, type ConsumeMessage, connect } from 'amqplib'

export type EventHandler = (event: EventEnvelope) => Promise<void>

export interface EventConsumerOptions {
  readonly url: string
  readonly queue: string
  readonly handlers: Readonly<Record<string, EventHandler>>
  readonly prefetch?: number
  readonly exchange?: string
  readonly deadLetterExchange?: string
  readonly connectTimeoutMs?: number
}

const meter = metrics.getMeter('knowledge.messaging')
const consumed = meter.createCounter('inbox_consumed_total')
const deadLettered = meter.createCounter('inbox_dead_lettered_total')
const unbound = meter.createCounter('inbox_unbound_total')

/** The inbox side of ADR 0024, as `files` has it: bound per event type, dead-lettered on a second failure. */
export class RabbitMqEventConsumer {
  private readonly logger = new Logger(RabbitMqEventConsumer.name)
  private connection: ChannelModel | undefined
  private channel: Channel | undefined
  private consumerTag: string | undefined

  constructor(private readonly options: EventConsumerOptions) {
    const prefetch = options.prefetch ?? 20
    if (!Number.isInteger(prefetch) || prefetch < 1 || prefetch > 1000)
      throw new Error('Consumer prefetch must be an integer between 1 and 1000')
    if (Object.keys(options.handlers).length === 0)
      throw new Error('A consumer with no handlers would bind nothing')
  }

  async start(): Promise<void> {
    const exchange = this.options.exchange ?? 'horizon.events'
    const deadLetterExchange = this.options.deadLetterExchange ?? 'horizon.events.dlx'
    const connection = await connect(this.options.url, {
      timeout: this.options.connectTimeoutMs ?? 5000,
    })
    this.connection = connection
    connection.on('error', () => undefined)
    const channel = await connection.createChannel()
    this.channel = channel
    channel.on('error', () => undefined)
    await channel.assertExchange(exchange, 'topic', { durable: true })
    await channel.assertExchange(deadLetterExchange, 'topic', { durable: true })
    await channel.assertQueue(`${this.options.queue}.dlq`, { durable: true })
    // Each queue's dead letters reach its own DLQ only (Phase 79). RabbitMQ stamps a dead
    // letter with the queue it died in, and a headers exchange routes on that stamp; the old
    // catch-all binding copied every module's dead letters into every DLQ.
    await channel.assertExchange('horizon.dead-letters', 'headers', { durable: true })
    await channel.bindExchange('horizon.dead-letters', deadLetterExchange, '#')
    await channel.unbindQueue(`${this.options.queue}.dlq`, deadLetterExchange, '#')
    await channel.bindQueue(`${this.options.queue}.dlq`, 'horizon.dead-letters', '', {
      'x-match': 'all-with-x',
      'x-first-death-queue': this.options.queue,
    })
    await channel.assertQueue(this.options.queue, { durable: true, deadLetterExchange })
    for (const eventType of Object.keys(this.options.handlers))
      await channel.bindQueue(this.options.queue, exchange, eventType)
    await channel.prefetch(this.options.prefetch ?? 20)
    const { consumerTag } = await channel.consume(this.options.queue, (message) => {
      if (message) void this.dispatch(channel, message)
    })
    this.consumerTag = consumerTag
  }

  private async dispatch(channel: Channel, message: ConsumeMessage): Promise<void> {
    const parent = propagation.extract(ROOT_CONTEXT, message.properties.headers ?? {})
    await trace
      .getTracer('knowledge.consumer')
      .startActiveSpan('inbox.consume', { kind: SpanKind.CONSUMER }, parent, async (span) => {
        try {
          const event = this.parse(message)
          if (!event) {
            deadLettered.add(1, { reason: 'undeliverable' })
            span.setStatus({ code: SpanStatusCode.ERROR })
            channel.nack(message, false, false)
            return
          }
          const handler = this.options.handlers[event.eventType]
          if (!handler) {
            // Left bound by a version that read this type (Phase 79): nothing here reads it now,
            // so the binding goes and the message is dropped rather than dead-lettered. The
            // routing key is the type, even for one replayed straight into the queue.
            await channel.unbindQueue(
              this.options.queue,
              this.options.exchange ?? 'horizon.events',
              event.eventType,
            )
            unbound.add(1, { event_type: event.eventType })
            this.logger.warn(`${event.eventType} is no longer read here; its binding was removed`)
            span.setStatus({ code: SpanStatusCode.OK })
            channel.ack(message)
            return
          }
          await handler(event)
          consumed.add(1, { event_type: event.eventType })
          span.setStatus({ code: SpanStatusCode.OK })
          channel.ack(message)
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR })
          const retry = !message.fields.redelivered
          this.reportFailure(message.fields.routingKey, error, retry)
          if (!retry) deadLettered.add(1, { reason: 'handler-failed' })
          channel.nack(message, false, retry)
        } finally {
          span.end()
        }
      })
  }

  /** The type and the error class only: a message may quote a payload with personal data. */
  private reportFailure(eventType: string, error: unknown, retry: boolean): void {
    const kind = error instanceof Error ? error.name : 'unknown'
    this.logger.warn(`${eventType} failed (${kind}); ${retry ? 'redelivering' : 'dead-lettering'}`)
  }

  private parse(message: ConsumeMessage): EventEnvelope | null {
    try {
      const event = eventEnvelopeSchema.parse(JSON.parse(message.content.toString()))
      const definition = findEvent(event.eventType, event.eventVersion)
      if (!definition) return null
      definition.payload.parse(event.payload)
      return event
    } catch {
      return null
    }
  }

  async close(): Promise<void> {
    if (this.consumerTag && this.channel) await this.channel.cancel(this.consumerTag)
    await this.channel?.close()
    await this.connection?.close()
  }

  onModuleInit(): Promise<void> {
    return this.start()
  }

  onModuleDestroy(): Promise<void> {
    return this.close()
  }
}
