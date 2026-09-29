import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import type { AssistantStore } from '@/application/assistant-ports'

/** Deletes conversations past their 30 days, across tenants, on a timer (Phase 76). */
export class PurgeWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PurgeWorker.name)
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly store: AssistantStore,
    private readonly intervalMs: number,
  ) {}

  onModuleInit(): void {
    void this.pass()
    this.timer = setInterval(() => void this.pass(), this.intervalMs)
    this.timer.unref()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async pass(): Promise<number> {
    try {
      return await this.store.purgeExpired()
    } catch (error) {
      this.logger.warn(`purge failed (${error instanceof Error ? error.name : 'Error'})`)
      return 0
    }
  }
}
