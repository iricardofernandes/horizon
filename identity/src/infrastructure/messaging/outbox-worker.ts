import { Logger } from '@nestjs/common'
import { OutboxRelay } from './outbox-relay'
import { RabbitMqEventPublisher } from './rabbitmq-event-publisher'

export interface OutboxWorkerOptions {
  readonly databaseUrl: string
  readonly rabbitmqUrl: string
  readonly intervalMs?: number
  readonly batchSize?: number
}

/** Only one flush is in flight; failed batches retry with bounded exponential jitter. */
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
        : Math.min(base * 2 ** Math.min(this.failures, 6), 30000) * (0.5 + Math.random() * 0.5)
    this.schedule(delay)
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.pending
    await Promise.allSettled([this.relay?.close(), this.publisher?.close()])
  }
}
