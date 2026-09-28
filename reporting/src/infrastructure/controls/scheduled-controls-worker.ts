import { Logger } from '@nestjs/common'
import postgres from 'postgres'
import type { RunConsistencyChecksUseCase } from '@/application/consistency'
import type { ReportReads } from '@/application/ports/report-store'
import type { RunReconciliationUseCase } from '@/application/use-cases/run-reconciliation'
import { REPORT_NAMES, REPORTS } from '@/domain/reports'
import type { ServiceTokens } from './service-tokens'

export const SERVICE_ACTOR = 'service:reporting'

/** Which tenants reporting holds history for, read as the relay role and nothing else. */
export class RelayTenantScan {
  readonly #client: ReturnType<typeof postgres>

  constructor(url: string) {
    this.#client = postgres(url, {
      max: 1,
      connect_timeout: 5,
      connection: { statement_timeout: 5000 },
    })
  }

  async tenants(): Promise<string[]> {
    const rows = await this.#client`select distinct tenant_id from source_watermarks`
    return rows.map((row) => String(row.tenant_id))
  }

  close(): Promise<void> {
    return this.#client.end({ timeout: 5 })
  }
}

/** The latest instant every source of a report is sealed through, if all of them are. */
export function settledCutoff(
  watermarks: ReadonlyMap<string, Date | null>,
  sources: readonly string[],
): Date | null {
  let cutoff: Date | null = null
  for (const source of sources) {
    const through = watermarks.get(source)
    if (!through) return null
    if (!cutoff || through < cutoff) cutoff = through
  }
  return cutoff
}

export interface ScheduledControlsOptions {
  readonly scan: RelayTenantScan
  readonly tokens: ServiceTokens
  readonly consistency: RunConsistencyChecksUseCase
  readonly reconciliation: RunReconciliationUseCase
  readonly reads: ReportReads
  readonly intervalMs: number
  readonly firstDelayMs: number
}

/**
 * Scheduled controls (ADR 0063, Phase 69): for every tenant, the consistency checks, then
 * each report reconciled at its latest settled cutoff — with the service identity, never a
 * person's token. A tenant that fails is logged and tried at the next interval.
 */
export class ScheduledControlsWorker {
  private readonly logger = new Logger(ScheduledControlsWorker.name)
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private stopped = false

  constructor(private readonly options: ScheduledControlsOptions) {}

  onModuleInit(): void {
    this.schedule(this.options.firstDelayMs)
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.pending
    await this.options.scan.close()
  }

  /** One pass over every tenant; exposed so a drill or a test can run it on demand. */
  async runOnce(): Promise<{ tenant: string; outcome: string }[]> {
    const results: { tenant: string; outcome: string }[] = []
    for (const tenant of await this.options.scan.tenants()) {
      if (this.stopped) break
      try {
        results.push({ tenant, outcome: await this.runTenant(tenant) })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.logger.warn(JSON.stringify({ event: 'controls.tenant-failed', tenant, message }))
        results.push({ tenant, outcome: 'failed' })
      }
    }
    return results
  }

  private async runTenant(tenant: string): Promise<string> {
    const bearer = await this.options.tokens.tokenFor(tenant)
    const run = await this.options.consistency.execute({
      tenantId: tenant,
      actor: SERVICE_ACTOR,
      requestId: null,
      trigger: 'scheduled',
      bearer,
    })
    const watermarks = await this.options.reads.watermarks(tenant)
    const reconciled: Record<string, string> = {}
    for (const name of REPORT_NAMES) {
      const cutoff = settledCutoff(watermarks, REPORTS[name].sources)
      if (!cutoff) {
        reconciled[name] = 'not-settled'
        continue
      }
      const outcome = await this.options.reconciliation.execute({
        context: {
          tenantId: tenant,
          actor: SERVICE_ACTOR,
          requestId: null,
          idempotencyKey: `scheduled:${name}:${cutoff.toISOString()}`,
        },
        name,
        cutoff,
        bearer,
      })
      reconciled[name] = outcome.isRight() ? outcome.value.outcome : outcome.value.message
    }
    this.logger.log(
      JSON.stringify({ event: 'controls.tenant', tenant, consistency: run.outcome, reconciled }),
    )
    return run.outcome
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.pending = this.runOnce()
        .then(() => undefined)
        .catch((error: unknown) => this.logger.error(`scheduled controls failed: ${String(error)}`))
        .finally(() => this.schedule(this.options.intervalMs))
    }, delayMs)
  }
}
