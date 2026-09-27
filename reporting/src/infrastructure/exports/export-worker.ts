import { Logger } from '@nestjs/common'
import { metrics } from '@opentelemetry/api'
import postgres from 'postgres'
import { ExportWorkScan } from '@/application/ports/export-store'
import type { ExportWorkUseCase } from '@/application/use-cases/exports'

const meter = metrics.getMeter('reporting.exports')
const written = meter.createCounter('reporting_exports_written_total')
const failed = meter.createCounter('reporting_exports_failed_total')
const expired = meter.createCounter('reporting_exports_expired_total')
const scheduled = meter.createCounter('reporting_export_runs_scheduled_total')

/** Asks across tenants only which ones have export work, as the relay role. */
export class RelayExportWorkScan extends ExportWorkScan {
  readonly #client: ReturnType<typeof postgres>

  constructor(url: string) {
    super()
    this.#client = postgres(url, {
      max: 1,
      connect_timeout: 5,
      connection: { statement_timeout: 5000 },
    })
  }

  async tenantsWithWork(now: Date, staleBefore: Date): Promise<string[]> {
    const at = now.toISOString()
    const stale = staleBefore.toISOString()
    const rows = await this.#client`
      select tenant_id from export_jobs
        where status = 'requested'
          or (status = 'running' and started_at <= ${stale}::timestamptz)
          or (status = 'ready' and expires_at <= ${at}::timestamptz)
      union
      select tenant_id from export_schedules
        where active and next_due_at <= ${at}::timestamptz`
    return rows.map((row) => String(row.tenant_id))
  }

  close(): Promise<void> {
    return this.#client.end({ timeout: 5 })
  }
}

export interface ExportWorkerOptions {
  readonly scan: RelayExportWorkScan
  readonly work: ExportWorkUseCase
  readonly intervalMs: number
  readonly leaseMs: number
}

/**
 * Turns due schedules into jobs, jobs into files, and expired files into history, tenant
 * by tenant. A failure is logged and tried again at the next interval.
 */
export class ExportWorker {
  private readonly logger = new Logger(ExportWorker.name)
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private stopped = false

  constructor(private readonly options: ExportWorkerOptions) {}

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
      const now = new Date()
      const tenants = await this.options.scan.tenantsWithWork(
        now,
        new Date(now.getTime() - this.options.leaseMs),
      )
      for (const tenantId of tenants) {
        const outcome = await this.options.work.runTenant(tenantId)
        scheduled.add(outcome.scheduled)
        written.add(outcome.written)
        failed.add(outcome.failed)
        expired.add(outcome.expired)
        if (outcome.expired > 0)
          this.logger.log(`Removed ${outcome.expired} expired export file(s) of one tenant`)
      }
    } catch (error) {
      const kind = error instanceof Error ? error.name : 'unknown'
      this.logger.warn(`Export work failed (${kind}); retrying at the next interval`)
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.pending
    await this.options.scan.close()
  }
}
