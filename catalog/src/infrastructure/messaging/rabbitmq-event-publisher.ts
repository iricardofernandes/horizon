import type { EventEnvelope } from '@horizon/contracts'
import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import { type ChannelModel, type ConfirmChannel, connect, type Message } from 'amqplib'
import type { EventPublisher } from './outbox-relay'

export class RabbitMqEventPublisher implements EventPublisher {
  private constructor(
    private readonly connection: ChannelModel,
    private readonly channel: ConfirmChannel,
    private readonly exchange: string,
    private readonly timeoutMs: number,
  ) {}

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

  async publish(event: EventEnvelope, traceParent?: string): Promise<void> {
    const parent = traceParent
      ? propagation.extract(ROOT_CONTEXT, { traceparent: traceParent })
      : ROOT_CONTEXT
    return trace
      .getTracer('catalog.outbox')
      .startActiveSpan('outbox.publish', { kind: SpanKind.PRODUCER }, parent, async (span) => {
        try {
          await this.confirm(event)
          span.setStatus({ code: SpanStatusCode.OK })
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR })
          throw error
        } finally {
          span.end()
        }
      })
  }

  /**
   * Mandatory and persistent: the broker returns an unroutable message instead of
   * dropping it, and the row stays pending until a queue exists to receive it.
   */
  private async confirm(event: EventEnvelope): Promise<void> {
    const headers: Record<string, string> = {}
    propagation.inject(context.active(), headers)
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error | null) => {
        clearTimeout(timer)
        this.channel.off('return', returned)
        if (error) {
          reject(error)
          return
        }
        resolve()
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
    await this.connection.close()
  }
}
