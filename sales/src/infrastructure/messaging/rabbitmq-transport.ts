import { type EventEnvelope, eventEnvelopeSchema, findEvent } from '@horizon/contracts'
import { Logger } from '@nestjs/common'
import {
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import {
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  connect,
  type Message,
} from 'amqplib'
import CircuitBreaker from 'opossum'
import postgres from 'postgres'

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

const meter = metrics.getMeter('sales.messaging')
const delivered = meter.createCounter('outbox_published_total')
const failed = meter.createCounter('outbox_publish_failures_total')
const lag = meter.createGauge('outbox_lag_seconds')
const consumed = meter.createCounter('inbox_consumed_total')
const deadLettered = meter.createCounter('inbox_dead_lettered_total')
const circuitOpened = meter.createCounter('messaging_circuit_opened_total')

export interface EventPublisher {
  publish(event: EventEnvelope, traceParent?: string): Promise<void>
}

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
      const rows = await tx`select * from outbox where dispatched_at is null
        order by created_at, id limit ${this.batchSize} for update skip locked`
      const [backlog] =
        await tx`select extract(epoch from now() - min(created_at)) as age from outbox where dispatched_at is null`
      lag.record(Number(backlog?.age ?? 0))
      let published = 0
      for (const row of rows) {
        try {
          await this.dispatch(row)
        } catch (error) {
          await tx`update outbox set attempts = least(attempts + 1, 32767),
            last_error = 'Delivery failed; see relay telemetry' where id = ${row.id}`
          failed.add(1)
          return { published, error }
        }
        await tx`update outbox set dispatched_at = now(), attempts = least(attempts + 1, 32767),
          last_error = null where id = ${row.id}`
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

export class RabbitMqEventPublisher implements EventPublisher {
  private readonly breaker: CircuitBreaker<[EventEnvelope], void>

  private constructor(
    private readonly connection: ChannelModel,
    private readonly channel: ConfirmChannel,
    private readonly exchange: string,
    private readonly timeoutMs: number,
  ) {
    this.breaker = new CircuitBreaker((event: EventEnvelope) => this.confirm(event), {
      timeout: timeoutMs,
      errorThresholdPercentage: 50,
      resetTimeout: 30_000,
      volumeThreshold: 5,
    })
    this.breaker.on('open', () => circuitOpened.add(1, { dependency: 'rabbitmq' }))
  }

  static async open(
    url: string,
    exchange = 'horizon.events',
    timeoutMs = 5000,
  ): Promise<RabbitMqEventPublisher> {
    const connection = await connect(url, { timeout: timeoutMs })
    try {
      const channel = await connection.createConfirmChannel()
      await channel.assertExchange(exchange, 'topic', { durable: true })
      connection.on('error', () => undefined)
      channel.on('error', () => undefined)
      return new RabbitMqEventPublisher(connection, channel, exchange, timeoutMs)
    } catch (error) {
      await connection.close()
      throw error
    }
  }

  publish(event: EventEnvelope, traceParent?: string): Promise<void> {
    const parent = traceParent
      ? propagation.extract(ROOT_CONTEXT, { traceparent: traceParent })
      : ROOT_CONTEXT
    return trace
      .getTracer('sales.outbox')
      .startActiveSpan('outbox.publish', { kind: SpanKind.PRODUCER }, parent, async (span) => {
        try {
          await this.breaker.fire(event)
          span.setStatus({ code: SpanStatusCode.OK })
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR })
          throw error
        } finally {
          span.end()
        }
      })
  }

  private async confirm(event: EventEnvelope): Promise<void> {
    const headers: Record<string, string> = {}
    propagation.inject(context.active(), headers)
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error | null) => {
        clearTimeout(timer)
        this.channel.off('return', returned)
        if (error) reject(error)
        else resolve()
      }
      const returned = (message: Message) => {
        if (message.properties.messageId === event.eventId)
          finish(new Error('RabbitMQ message has no matching queue'))
      }
      const timer = setTimeout(
        () => finish(new Error('RabbitMQ publish confirmation timed out')),
        this.timeoutMs,
      )
      this.channel.on('return', returned)
      try {
        this.channel.publish(
          this.exchange,
          event.eventType,
          Buffer.from(JSON.stringify(event)),
          {
            mandatory: true,
            persistent: true,
            contentType: 'application/json',
            messageId: event.eventId,
            timestamp: Math.floor(Date.now() / 1000),
            headers,
          },
          finish,
        )
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Publish failed'))
      }
    })
  }

  async close(): Promise<void> {
    this.breaker.shutdown()
    await this.connection.close()
  }
}

export class RabbitMqEventConsumer {
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
    await channel.bindQueue(`${this.options.queue}.dlq`, deadLetterExchange, '#')
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
      .getTracer('sales.consumer')
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
          if (!handler) throw new Error('No handler for a bound event type')
          await handler(event)
          consumed.add(1, { event_type: event.eventType })
          span.setStatus({ code: SpanStatusCode.OK })
          channel.ack(message)
        } catch {
          span.setStatus({ code: SpanStatusCode.ERROR })
          const retry = !message.fields.redelivered
          if (!retry) deadLettered.add(1, { reason: 'handler-failed' })
          channel.nack(message, false, retry)
        } finally {
          span.end()
        }
      })
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

export interface OutboxWorkerOptions {
  readonly databaseUrl: string
  readonly rabbitmqUrl: string
  readonly intervalMs?: number
  readonly batchSize?: number
}

export class OutboxWorker {
  private readonly logger = new Logger(OutboxWorker.name)
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private stopped = false
  private failures = 0
  private publisher: RabbitMqEventPublisher | undefined
  private relay: OutboxRelay | undefined

  constructor(private readonly options: OutboxWorkerOptions) {
    if (!Number.isInteger(options.intervalMs ?? 1000) || (options.intervalMs ?? 1000) < 100)
      throw new Error('Outbox poll interval must be at least 100ms')
  }

  onModuleInit(): void {
    this.schedule(0)
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.pending = this.poll()
    }, delay)
  }

  private async poll(): Promise<void> {
    try {
      this.publisher ??= await RabbitMqEventPublisher.open(this.options.rabbitmqUrl)
      this.relay ??= new OutboxRelay(
        this.options.databaseUrl,
        this.publisher,
        this.options.batchSize,
      )
      await this.relay.flush()
      this.failures = 0
    } catch {
      this.failures += 1
      this.logger.error('Outbox delivery failed; the pending batch will be retried')
      await Promise.allSettled([this.relay?.close(), this.publisher?.close()])
      this.relay = undefined
      this.publisher = undefined
    }
    const base = this.options.intervalMs ?? 1000
    const delay =
      this.failures === 0
        ? base
        : Math.min(base * 2 ** Math.min(this.failures, 6), 30_000) * (0.5 + Math.random() * 0.5)
    this.schedule(delay)
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.pending
    await Promise.allSettled([this.relay?.close(), this.publisher?.close()])
  }
}
