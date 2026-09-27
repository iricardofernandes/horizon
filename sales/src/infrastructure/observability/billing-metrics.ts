import { Logger } from '@nestjs/common'
import { metrics } from '@opentelemetry/api'
import postgres from 'postgres'
import type { BillingMetrics } from '@/application/ports/billing-metrics'

/**
 * Contract billing metrics (Phase 52). No label names a tenant, contract or customer:
 * outcomes and reasons are bounded values (ADR 0055).
 */
const meter = metrics.getMeter('sales.billing')

const outcomes = meter.createCounter('sales_contract_billing_outcomes', {
  description: 'Contracts decided by billing runs, by outcome and reason.',
})
const duration = meter.createHistogram('sales_contract_billing_run_duration_seconds', {
  description: 'Seconds from the start of a billing run to its completion.',
  advice: { explicitBucketBoundaries: [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900, 3600] },
})

export const openTelemetryBillingMetrics: BillingMetrics = {
  decided: (outcome, reason) => outcomes.add(1, { outcome, reason: reason ?? 'none' }),
  runFinished: (seconds) => duration.record(Math.max(0, seconds)),
}

export interface BillingGaugeOptions {
  /** The relay connection: it may count billed periods across tenants, and nothing more. */
  readonly databaseUrl: string
  /** How old a billed period may be before a missing receivable or NFS-e counts. */
  readonly thresholdSeconds: number
  readonly intervalMs?: number
}

/**
 * Gauges of billed periods, not credited and older than the threshold, still without a
 * posted receivable or without an authorized NFS-e on every line. A scrape reads the last
 * snapshot; a failed refresh keeps it and counts itself.
 */
export class BillingGauges {
  private readonly logger = new Logger(BillingGauges.name)
  private readonly client: ReturnType<typeof postgres>
  private timer: ReturnType<typeof setInterval> | undefined
  private snapshot: { withoutReceivable: number; withoutNfse: number } | null = null
  private readonly refreshFailures = meter.createCounter('sales_billing_gauge_refresh_failures', {
    description: 'Billing gauge refreshes that failed.',
  })

  constructor(private readonly options: BillingGaugeOptions) {
    this.client = postgres(options.databaseUrl, {
      max: 1,
      connect_timeout: 5,
      connection: { statement_timeout: 5000 },
    })
    meter
      .createObservableGauge('sales_contract_periods_without_receivable', {
        description: 'Billed periods older than the threshold without a posted receivable.',
      })
      .addCallback((result) => {
        if (this.snapshot) result.observe(this.snapshot.withoutReceivable)
      })
    meter
      .createObservableGauge('sales_contract_periods_without_nfse', {
        description: 'Billed periods older than the threshold without an authorized NFS-e.',
      })
      .addCallback((result) => {
        if (this.snapshot) result.observe(this.snapshot.withoutNfse)
      })
  }

  onModuleInit(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.options.intervalMs ?? 30_000)
    this.timer.unref()
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    await this.client.end({ timeout: 5 })
  }

  /** Reads the counts again; returns what the gauges now report. */
  async refresh(): Promise<{ withoutReceivable: number; withoutNfse: number } | null> {
    try {
      const [row] = await this.client`select
          count(*) filter (where period.receivable_posted_at is null)::int as without_receivable,
          count(*) filter (where exists (
            select 1 from contract_billed_period_lines line
            where line.billed_period_id = period.id
              and line.nfse_status is distinct from ${'authorized'}))::int as without_nfse
        from contract_billed_periods period
        where period.credit_reason_code is null
          and period.billed_at < now() - make_interval(secs => ${this.options.thresholdSeconds})`
      this.snapshot = {
        withoutReceivable: Number(row?.without_receivable ?? 0),
        withoutNfse: Number(row?.without_nfse ?? 0),
      }
    } catch {
      this.refreshFailures.add(1)
      this.logger.error('Billing gauges could not be refreshed; the last snapshot is kept')
    }
    return this.snapshot
  }
}
