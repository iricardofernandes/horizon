import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import type { Indexing } from '@/application/indexing'
import type { RelayDueScan } from '@/infrastructure/database/knowledge-database'

export interface IndexWorkerOptions {
  readonly scan: RelayDueScan
  readonly indexing: Indexing
  readonly indexVersion: string
  readonly intervalMs: number
  readonly lag: (seconds: number) => void
}

/**
 * Finds the tenants with due documents as the relay role, then indexes each in its own
 * tenant's transactions (Phase 74). A pass that fails is logged by class and retried on
 * the next tick; a document's own failure is its row's, with its backoff.
 */
export class IndexWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexWorker.name)
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private stopped = false

  constructor(private readonly options: IndexWorkerOptions) {}

  onModuleInit(): void {
    this.schedule(1000)
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.running
    await this.options.scan.close()
  }

  /** One pass: every tenant with work, until each has none left or the pass is long enough. */
  async pass(): Promise<number> {
    const now = new Date()
    this.options.lag(await this.options.scan.lagSeconds(now))
    let indexed = 0
    for (const tenantId of await this.options.scan.tenantsWithWork(now, this.options.indexVersion))
      indexed += await this.options.indexing.indexDue(tenantId)
    return indexed
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.running = this.pass().then(
        (count) => this.schedule(count > 0 ? 0 : this.options.intervalMs),
        (error: unknown) => {
          this.logger.warn(`index pass failed (${error instanceof Error ? error.name : 'Error'})`)
          this.schedule(this.options.intervalMs)
        },
      )
    }, delayMs)
  }
}
