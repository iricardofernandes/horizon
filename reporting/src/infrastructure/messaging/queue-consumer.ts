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
import { Undeliverable } from '@/application/journal-intake'

export interface QueueConsumerOptions {
  readonly url: string
  readonly queue: string
  /** Event types bound on the topic exchange; none for a queue fed through the default exchange. */
  readonly bindings: readonly string[]
  readonly handle: (body: unknown) => Promise<string>
  readonly prefetch: number
  readonly exchange?: string
  readonly deadLetterExchange?: string
  readonly connectTimeoutMs?: number
}

const meter = metrics.getMeter('reporting.messaging')
const consumed = meter.createCounter('reporting_journal_messages_total')
const deadLettered = meter.createCounter('inbox_dead_lettered_total')

/**
 * One durable queue with a dead-letter queue. A message that cannot be parsed is
 * dead-lettered at once; a failing handler is retried once, then dead-lettered.
 */
export class QueueConsumer {
  private readonly logger = new Logger(QueueConsumer.name)
  private connection: ChannelModel | undefined
  private channel: Channel | undefined
  private consumerTag: string | undefined

  constructor(private readonly options: QueueConsumerOptions) {
    if (!Number.isInteger(options.prefetch) || options.prefetch < 1 || options.prefetch > 1000)
      throw new Error('Consumer prefetch must be an integer between 1 and 1000')
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
    for (const eventType of this.options.bindings)
      await channel.bindQueue(this.options.queue, exchange, eventType)
    await channel.prefetch(this.options.prefetch)
    const { consumerTag } = await channel.consume(this.options.queue, (message) => {
      if (message) void this.dispatch(channel, message)
    })
    this.consumerTag = consumerTag
  }

  private async dispatch(channel: Channel, message: ConsumeMessage): Promise<void> {
    const parent = propagation.extract(ROOT_CONTEXT, message.properties.headers ?? {})
    await trace
      .getTracer('reporting.consumer')
      .startActiveSpan('journal.consume', { kind: SpanKind.CONSUMER }, parent, async (span) => {
        try {
          const outcome = await this.options.handle(this.parse(message))
          consumed.add(1, { queue: this.options.queue, outcome })
          span.setStatus({ code: SpanStatusCode.OK })
          channel.ack(message)
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR })
          const retry = !(error instanceof Undeliverable) && !message.fields.redelivered
          this.reportFailure(message.fields.routingKey, error, retry)
          if (!retry) deadLettered.add(1, { queue: this.options.queue })
          channel.nack(message, false, retry)
        } finally {
          span.end()
        }
      })
  }

  private parse(message: ConsumeMessage): unknown {
    try {
      return JSON.parse(message.content.toString())
    } catch {
      throw new Undeliverable('not JSON')
    }
  }

  /** The routing key and the error class only: a message may quote a payload. */
  private reportFailure(routingKey: string, error: unknown, retry: boolean): void {
    const kind = error instanceof Error ? error.name : 'unknown'
    this.logger.warn(`${routingKey} failed (${kind}); ${retry ? 'redelivering' : 'dead-lettering'}`)
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
