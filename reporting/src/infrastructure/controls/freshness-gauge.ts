import { Logger } from '@nestjs/common'
import { metrics } from '@opentelemetry/api'
import postgres from 'postgres'

const meter = metrics.getMeter('reporting.freshness')
const failures = meter.createCounter('reporting_freshness_refresh_failures_total', {
  description: 'Failed refreshes of the report freshness gauge.',
})

export interface FreshnessGaugeOptions {
  /** The relay connection: it reads watermark instants, and nothing more. */
  readonly databaseUrl: string
  readonly intervalMs?: number
}

/**
 * Report freshness (Phase 70): per source, the seconds since the oldest tenant's
 * watermark. A report is only as fresh as the least-sealed tenant's sources, and a source
 * whose seals stop ages here until the alert fires. No label names a tenant (ADR 0055).
 */
export class FreshnessGauge {
  private readonly logger = new Logger(FreshnessGauge.name)
  private readonly client: ReturnType<typeof postgres>
  private snapshot = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: FreshnessGaugeOptions) {
    this.client = postgres(options.databaseUrl, {
      max: 1,
      connect_timeout: 5,
      connection: { statement_timeout: 5000 },
    })
    meter
      .createObservableGauge('reporting_source_freshness_seconds', {
        description: 'Seconds since the oldest tenant watermark of each journaled source.',
      })
      .addCallback((result) => {
        for (const [source, seconds] of this.snapshot) result.observe(seconds, { source })
      })
  }

  onModuleInit(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.options.intervalMs ?? 60_000)
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    await this.client.end({ timeout: 5 })
  }

  async refresh(): Promise<ReadonlyMap<string, number>> {
    try {
      const rows = await this.client<{ source: string; seconds: number }[]>`
        select source_module as source,
          extract(epoch from now() - min(through))::float8 as seconds
        from source_watermarks group by source_module`
      this.snapshot = new Map(rows.map((row) => [row.source, Math.max(0, Number(row.seconds))]))
    } catch (error) {
      failures.add(1)
      this.logger.warn(`report freshness refresh failed: ${String(error)}`)
    }
    return this.snapshot
  }
}
