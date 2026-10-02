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
  /** Routing keys bound on the topic exchange. */
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
    const deadLetterExchange = this.options.deadLetterExchange ?? `${this.options.queue}.dlx`
    const connection = await connect(this.options.url, {
      timeout: this.options.connectTimeoutMs ?? 5000,
    })
    this.connection = connection
    connection.on('error', () => undefined)
    const channel = await connection.createChannel()
    this.channel = channel
    channel.on('error', () => undefined)
    await channel.assertExchange(exchange, 'topic', { durable: true })
    // Each queue dead-letters into an exchange of its own (Phase 90). Reporting's broker user
    // may write only to its own names, and a shared exchange would let any module place a
    // message in another module's dead-letter queue.
    await channel.assertExchange(deadLetterExchange, 'fanout', { durable: true })
    await channel.assertQueue(`${this.options.queue}.dlq`, { durable: true })
    await channel.bindQueue(`${this.options.queue}.dlq`, deadLetterExchange, '')
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
          const body = this.parse(message)
          if (!publishedAs(message, body)) throw new Undeliverable('misrouted')
          const outcome = await this.options.handle(body)
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

/**
 * A message is what it was published as (Phase 90). Each module's broker user may publish
 * only routing keys of its own: an event under its type, a journal seal under
 * `<source>.seal`. So a module cannot seal or resend another module's journal, or send
 * another module's event under a key of its own. A message from the default exchange was
 * put back by an operator: no module may write there.
 */
export function publishedAs(message: Pick<ConsumeMessage, 'fields'>, body: unknown): boolean {
  if (message.fields.exchange === '') return true
  if (!body || typeof body !== 'object') return false
  const record = body as { kind?: unknown; source?: unknown; eventType?: unknown }
  if (record.kind === 'seal')
    return (
      typeof record.source === 'string' && message.fields.routingKey === `${record.source}.seal`
    )
  return typeof record.eventType === 'string' && message.fields.routingKey === record.eventType
}
