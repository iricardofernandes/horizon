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
    await this.channel.assertExchange('horizon.events.dlx', 'topic', { durable: true })
    const queue = this.options.queue ?? 'webhooks.events'
    await this.channel.assertQueue(`${queue}.dlq`, { durable: true })
    // Each queue's dead letters reach its own DLQ only (Phase 79). RabbitMQ stamps a dead
    // letter with the queue it died in, and a headers exchange routes on that stamp; the old
    // catch-all binding copied every module's dead letters into every DLQ.
    await this.channel.assertExchange('horizon.dead-letters', 'headers', { durable: true })
    await this.channel.bindExchange('horizon.dead-letters', 'horizon.events.dlx', '#')
    await this.channel.unbindQueue(`${queue}.dlq`, 'horizon.events.dlx', '#')
    await this.channel.bindQueue(`${queue}.dlq`, 'horizon.dead-letters', '', {
      'x-match': 'all-with-x',
      'x-first-death-queue': queue,
    })
    await this.channel.assertQueue(queue, {
      durable: true,
      deadLetterExchange: 'horizon.events.dlx',
    })
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
