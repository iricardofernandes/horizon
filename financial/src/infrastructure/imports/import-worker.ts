import { Logger } from '@nestjs/common'
import { metrics } from '@opentelemetry/api'
import postgres from 'postgres'
import type { ImportJobs } from '@/application/imports/imports'

const meter = metrics.getMeter('imports')
const written = meter.createCounter('import_rows_written_total')
const rejected = meter.createCounter('import_rows_rejected_total')
const finished = meter.createCounter('import_jobs_finished_total')

/** Asks across tenants only which ones have import work, as the relay role. */
export class RelayImportScan {
  readonly #client: ReturnType<typeof postgres>

  constructor(url: string) {
    this.#client = postgres(url, {
      max: 1,
      connect_timeout: 5,
      connection: { statement_timeout: 5000 },
    })
  }

  async tenantsWithWork(now: Date, staleBefore: Date): Promise<string[]> {
    const at = now.toISOString()
    const rows = await this.#client`
      select distinct tenant_id from import_jobs
        where (status = 'running' and (lease_until is null or lease_until <= ${at}::timestamptz))
          or (purged_at is null and failures_until <= ${at}::timestamptz)
          or (status in ('uploaded', 'validated', 'previewed')
            and updated_at < ${staleBefore.toISOString()}::timestamptz)`
    return rows.map((row) => String(row.tenant_id))
  }

  close(): Promise<void> {
    return this.#client.end({ timeout: 5 })
  }
}

export interface ImportWorkerOptions {
  readonly scan: RelayImportScan
  readonly jobs: ImportJobs
  readonly intervalMs: number
  readonly retentionMs: number
}

/**
 * Writes confirmed imports batch by batch and forgets their rows when retention allows,
 * tenant by tenant. A job whose worker stopped is taken again once its lease lapses, and
 * carries on from its first row not yet written.
 */
export class ImportWorker {
  private readonly logger = new Logger(ImportWorker.name)
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private stopped = false

  constructor(private readonly options: ImportWorkerOptions) {}

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
        new Date(now.getTime() - this.options.retentionMs),
      )
      for (const tenantId of tenants) {
        if (this.stopped) return
        const outcome = await this.options.jobs.runTenant(tenantId)
        written.add(outcome.written)
        rejected.add(outcome.rejected)
        finished.add(outcome.finished)
        if (outcome.purged + outcome.abandoned > 0)
          this.logger.log(
            `Cleared ${outcome.purged} expired and ${outcome.abandoned} abandoned import(s) of one tenant`,
          )
      }
    } catch (error) {
      const kind = error instanceof Error ? error.name : 'unknown'
      this.logger.warn(`Import work failed (${kind}); retrying at the next interval`)
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.pending
    await this.options.scan.close()
  }
}
