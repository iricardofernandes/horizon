import { Logger } from '@nestjs/common'
import type { WebhookDispatcher } from '@/application/webhook-service'

export class DeliveryWorker {
  private readonly logger = new Logger(DeliveryWorker.name)
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private stopped = false

  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly intervalMs = 250,
  ) {}

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
      const result = await this.dispatcher.flush()
      if (result.overDepthLimit)
        this.logger.error({ event: 'webhook.queue-depth-exceeded', depth: result.queueDepth })
    } catch {
      this.logger.error('Webhook delivery poll failed')
    } finally {
      this.schedule(this.intervalMs)
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.pending
  }
}
