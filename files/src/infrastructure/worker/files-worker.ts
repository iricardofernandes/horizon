import { Logger } from '@nestjs/common'
import { metrics } from '@opentelemetry/api'
import type { AttachmentLifecycle } from '@/application/lifecycle'
import type { RelayDueScan } from '@/infrastructure/database/drizzle/files-database'

const meter = metrics.getMeter('files.lifecycle')
const scanned = meter.createCounter('files_attachments_scanned_total')
const expired = meter.createCounter('files_attachments_expired_total')
const purged = meter.createCounter('files_objects_removed_total')
const abandoned = meter.createCounter('files_uploads_abandoned_total')
const failed = meter.createCounter('files_lifecycle_failures_total')

export interface FilesWorkerOptions {
  readonly scan: RelayDueScan
  readonly lifecycle: AttachmentLifecycle
  readonly intervalMs: number
}

/**
 * Retries scans, expires by retention, removes bytes and abandons slots, tenant by tenant.
 * A failure is logged and tried again at the next interval.
 */
export class FilesWorker {
  private readonly logger = new Logger(FilesWorker.name)
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private stopped = false

  constructor(private readonly options: FilesWorkerOptions) {}

  onModuleInit(): void {
    this.schedule(0)
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.pending = this.tick().finally(() => this.schedule(this.options.intervalMs))
    }, delay)
  }

  async tick(): Promise<void> {
    try {
      for (const tenantId of await this.options.scan.tenantsWithWork(new Date())) {
        const outcome = await this.options.lifecycle.runTenant(tenantId)
        scanned.add(outcome.scanned)
        expired.add(outcome.expired)
        purged.add(outcome.purged)
        abandoned.add(outcome.abandoned)
        failed.add(outcome.failed)
        if (outcome.purged > 0)
          this.logger.log(`Removed the bytes of ${outcome.purged} attachment(s) of one tenant`)
      }
    } catch (error) {
      const kind = error instanceof Error ? error.name : 'unknown'
      this.logger.warn(`Attachment work failed (${kind}); retrying at the next interval`)
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.pending
    await this.options.scan.close()
  }
}
