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
  readonly handlers: Readonly<Record<string, EventHandler>>
  readonly queue?: string
  readonly exchange?: string
  readonly deadLetterExchange?: string
  readonly prefetch?: number
  readonly connectTimeoutMs?: number
}

const meter = metrics.getMeter('catalog.consumer')
const consumed = meter.createCounter('inbox_consumed_total')
const deadLettered = meter.createCounter('inbox_dead_lettered_total')

/**
 * Durable topology, bounded prefetch, explicit dead-lettering (ADR 0024, ADR 0027).
 *
 * The failure policy is deliberately two-valued, because "retry forever" and "drop" are
 * both wrong:
 *
 * - A message that cannot be understood — malformed JSON, an envelope that fails its
 *   schema, an event type or version this module has no contract for — is dead-lettered
 *   immediately. Redelivering it would produce the same verdict until someone intervenes,
 *   and a poison message must not hold up the queue behind it.
 * - A handler that throws gets exactly one immediate redelivery, then the message is
 *   dead-lettered. That covers the transient case — a database blip, a lock timeout —
 *   without turning a persistent bug into an infinite loop that hides it.
 *
 * The dead-letter queue is the queue a human looks at. Nothing is discarded.
 */
export class RabbitMqEventConsumer {
  private readonly logger = new Logger(RabbitMqEventConsumer.name)
  private connection: ChannelModel | undefined
  private channel: Channel | undefined
  private consumerTag: string | undefined
  private stopped = false

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
    const queue = this.options.queue ?? 'catalog.events'
    const connection = await connect(this.options.url, {
      timeout: this.options.connectTimeoutMs ?? 5000,
    })
    this.connection = connection
    connection.on('error', () => this.logger.error('Broker connection failed'))
    const channel = await connection.createChannel()
    this.channel = channel
    channel.on('error', () => this.logger.error('Broker channel failed'))

    await channel.assertExchange(exchange, 'topic', { durable: true })
    await channel.assertExchange(deadLetterExchange, 'topic', { durable: true })
    await channel.assertQueue(`${queue}.dlq`, { durable: true })
    await channel.bindQueue(`${queue}.dlq`, deadLetterExchange, '#')
    await channel.assertQueue(queue, {
      durable: true,
      deadLetterExchange,
    })
    for (const eventType of Object.keys(this.options.handlers))
      await channel.bindQueue(queue, exchange, eventType)
    // Bounded in-flight work: an unbounded prefetch turns a slow handler into unbounded
    // memory and hides a backlog that should be visible in the queue (ADR 0027).
    await channel.prefetch(this.options.prefetch ?? 20)

    const { consumerTag } = await channel.consume(queue, (message) => {
      if (message === null) return
      void this.dispatch(channel, message)
    })
    this.consumerTag = consumerTag
  }

  private async dispatch(channel: Channel, message: ConsumeMessage): Promise<void> {
    const parent = propagation.extract(ROOT_CONTEXT, message.properties.headers ?? {})
    await trace
      .getTracer('catalog.consumer')
      .startActiveSpan('inbox.consume', { kind: SpanKind.CONSUMER }, parent, async (span) => {
        try {
          const event = this.parse(message)
          if (event === null) {
            deadLettered.add(1, { reason: 'undeliverable' })
            span.setStatus({ code: SpanStatusCode.ERROR })
            channel.nack(message, false, false)
            return
          }
          const handler = this.options.handlers[event.eventType]
          if (handler === undefined) throw new Error('No handler for a bound event type')
          await handler(event)
          consumed.add(1, { event_type: event.eventType })
          span.setStatus({ code: SpanStatusCode.OK })
          // Only now: the effect and its inbox claim are committed (ADR 0024).
          channel.ack(message)
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR })
          this.rejectAfterFailure(channel, message, error)
        } finally {
          span.end()
        }
      })
  }

  /** Null means "this will never succeed", which is a different decision from a throw. */
  private parse(message: ConsumeMessage): EventEnvelope | null {
    try {
      const envelope = eventEnvelopeSchema.parse(JSON.parse(message.content.toString()))
      const definition = findEvent(envelope.eventType, envelope.eventVersion)
      if (!definition) {
        this.logger.warn({
          event: 'inbox.unknown-contract',
          eventType: envelope.eventType,
          eventVersion: envelope.eventVersion,
        })
        return null
      }
      definition.payload.parse(envelope.payload)
      return envelope
    } catch {
      this.logger.warn({ event: 'inbox.undeliverable', messageId: message.properties.messageId })
      return null
    }
  }

  private rejectAfterFailure(channel: Channel, message: ConsumeMessage, error: unknown): void {
    const retry = !message.fields.redelivered
    this.logger.error({
      event: retry ? 'inbox.retrying' : 'inbox.dead-lettered',
      messageId: message.properties.messageId,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    })
    if (!retry) deadLettered.add(1, { reason: 'handler-failed' })
    channel.nack(message, false, retry)
  }

  async onModuleInit(): Promise<void> {
    await this.start()
  }

  /**
   * Stop taking work, let what is in flight finish, then close — in that order and one
   * at a time. Closing the connection while a channel close is still in flight leaves
   * the channel promise waiting for a reply that the destroyed socket will never carry.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    try {
      if (this.consumerTag && this.channel) await this.channel.cancel(this.consumerTag)
    } catch {
      this.logger.warn('Consumer cancellation failed during shutdown')
    }
    try {
      await this.channel?.close()
    } catch {
      this.logger.warn('Channel close failed during shutdown')
    }
    try {
      await this.connection?.close()
    } catch {
      this.logger.warn('Broker connection close failed during shutdown')
    }
  }

  /** Whether shutdown has been requested, for callers that schedule their own work. */
  isStopped(): boolean {
    return this.stopped
  }
}
