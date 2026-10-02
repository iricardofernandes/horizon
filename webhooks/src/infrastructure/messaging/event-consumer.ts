import { eventEnvelopeSchema, findEvent } from '@horizon/contracts'
import {
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import { type Channel, type ChannelModel, type ConsumeMessage, connect } from 'amqplib'
import type { WebhookRepository } from '@/application/webhook-service'

// The same inbox SLIs every other consumer exports (Phase 70), so a dead letter here is seen.
const meter = metrics.getMeter('webhooks.messaging')
const consumed = meter.createCounter('inbox_consumed_total')
const deadLettered = meter.createCounter('inbox_dead_lettered_total')

export class WebhookEventConsumer {
  private connection: ChannelModel | undefined
  private channel: Channel | undefined
  private consumerTag: string | undefined

  constructor(
    private readonly options: {
      url: string
      repository: WebhookRepository
      queue?: string
      prefetch?: number
    },
  ) {}

  async start(): Promise<void> {
    this.connection = await connect(this.options.url, { timeout: 5000 })
    this.channel = await this.connection.createChannel()
    await this.channel.assertExchange('horizon.events', 'topic', { durable: true })
    const queue = this.options.queue ?? 'webhooks.events'
    const deadLetterExchange = `${queue}.dlx`
    // The queue dead-letters into an exchange of its own (Phase 90). The module's broker user
    // may write only to its own names, and a shared exchange would let any module place a
    // message in another module's dead-letter queue.
    await this.channel.assertExchange(deadLetterExchange, 'fanout', { durable: true })
    await this.channel.assertQueue(`${queue}.dlq`, { durable: true })
    await this.channel.bindQueue(`${queue}.dlq`, deadLetterExchange, '')
    await this.channel.assertQueue(queue, { durable: true, deadLetterExchange })
    // Webhook subscriptions can target any published contract. The catch-all binding also
    // guarantees that mandatory outbox publications always have a durable route.
    await this.channel.bindQueue(queue, 'horizon.events', '#')
    await this.channel.prefetch(this.options.prefetch ?? 20)
    const result = await this.channel.consume(queue, (message) => {
      if (message) void this.dispatch(message)
    })
    this.consumerTag = result.consumerTag
  }

  private async dispatch(message: ConsumeMessage): Promise<void> {
    if (!this.channel) return
    const channel = this.channel
    const parent = propagation.extract(ROOT_CONTEXT, message.properties.headers ?? {})
    await trace
      .getTracer('webhooks.consumer')
      .startActiveSpan('inbox.consume', { kind: SpanKind.CONSUMER }, parent, async (span) => {
        try {
          const event = eventEnvelopeSchema.parse(JSON.parse(message.content.toString()))
          if (!routedAs(message, event.eventType)) {
            deadLettered.add(1, { reason: 'misrouted' })
            span.setStatus({ code: SpanStatusCode.ERROR })
            channel.nack(message, false, false)
            return
          }
          const definition = findEvent(event.eventType, event.eventVersion)
          if (!definition) throw new Error('Unknown event contract')
          const payload = definition.payload.parse(event.payload) as Readonly<
            Record<string, unknown>
          >
          await this.options.repository.recordEvent({ ...event, payload }, new Date())
          span.setStatus({ code: SpanStatusCode.OK })
          channel.ack(message)
          consumed.add(1, { event_type: event.eventType })
        } catch (error) {
          span.recordException(error instanceof Error ? error : new Error('Event handling failed'))
          span.setStatus({ code: SpanStatusCode.ERROR })
          const retry = message.fields.redelivered === false
          if (!retry) deadLettered.add(1, { reason: 'handler-failed' })
          channel.nack(message, false, retry)
        } finally {
          span.end()
        }
      })
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
 * A message is the event it was published as (Phase 90). Each module's broker user may
 * publish only its own routing keys, so a module that sends another module's event under a
 * key of its own is refused here. A message from the default exchange was put back by an
 * operator: no module may write there.
 */
function routedAs(message: ConsumeMessage, eventType: string): boolean {
  return message.fields.exchange === '' || message.fields.routingKey === eventType
}
