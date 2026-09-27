import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import {
  cutoffOf,
  NO_FILTER,
  REPORT_NAMES,
  REPORTS,
  type ReportFilter,
  type ReportName,
} from '@/domain/reports'
import { isSettled, settlementOf } from '@/domain/settlement'
import type { Clock } from '../ports/journal-store'
import type { ReportReads, StoredRun } from '../ports/report-store'
import type { ReportData } from '../report-data'

export interface ReportRequest<N extends ReportName = ReportName> {
  readonly tenantId: string
  readonly name: N
  readonly cutoff: Date | null
  readonly filter: ReportFilter
}

export interface ReportAnswer<N extends ReportName = ReportName> {
  readonly report: N
  readonly cutoff: Date
  /** True when every source the report reads is proven complete through the cutoff. */
  readonly settled: boolean
  readonly sources: readonly {
    readonly source: string
    readonly watermark: Date | null
    readonly settled: boolean
  }[]
  readonly filter: ReportFilter
  readonly data: ReportData[N]
  readonly checks: readonly { readonly name: string; readonly owner: string }[]
  readonly derived: readonly { readonly figure: string; readonly from: string }[]
  /** The latest reconciliation run at exactly this cutoff, if any. */
  readonly reconciliation: StoredRun | null
}

/** A report at a cutoff, with what it reads, how settled it is, and how it was proven. */
export class ReadReportUseCase {
  constructor(
    private readonly reads: ReportReads,
    private readonly clock: Clock,
  ) {}

  async execute<N extends ReportName>(
    request: ReportRequest<N>,
  ): Promise<Either<InvalidInputError, ReportAnswer<N>>> {
    const cutoff = cutoffOf(request.cutoff, this.clock.now())
    if (cutoff.isLeft()) return left(cutoff.value)
    const at = cutoff.value
    const definition = REPORTS[request.name]
    const watermarks = await this.reads.watermarks(request.tenantId)
    const data = await this.reads.report(request.tenantId, request.name, at, request.filter)
    return right({
      report: request.name,
      cutoff: at,
      settled: settlementOf(watermarks, at, definition.sources).settled,
      sources: definition.sources.map((source) => {
        const watermark = watermarks.get(source) ?? null
        return { source, watermark, settled: isSettled(watermark, at) }
      }),
      filter: request.filter,
      data,
      checks: definition.checks.map((check) => ({ name: check.name, owner: check.owner })),
      derived: definition.derived,
      reconciliation: await this.reads.latestRun(request.tenantId, request.name, at),
    })
  }
}

/** The headline of every report at one cutoff, for the dashboard. */
export class DashboardUseCase {
  private readonly report: ReadReportUseCase

  constructor(reads: ReportReads, clock: Clock) {
    this.report = new ReadReportUseCase(reads, clock)
  }

  async execute(request: {
    readonly tenantId: string
    readonly cutoff: Date | null
  }): Promise<Either<InvalidInputError, DashboardAnswer>> {
    const answers: Partial<Record<ReportName, ReportAnswer>> = {}
    let cutoff: Date | null = request.cutoff
    for (const name of REPORT_NAMES) {
      const answer = await this.report.execute({
        tenantId: request.tenantId,
        name,
        cutoff,
        filter: NO_FILTER,
      })
      if (answer.isLeft()) return left(answer.value)
      // Every report is read at the first one's cutoff, so the headlines agree in time.
      cutoff = answer.value.cutoff
      answers[name] = answer.value
    }
    return right(headlinesOf(answers as Record<ReportName, ReportAnswer>))
  }
}

export interface DashboardAnswer {
  readonly cutoff: Date
  readonly reports: Readonly<
    Record<ReportName, { readonly settled: boolean; readonly headline: unknown }>
  >
}

function headlinesOf(answers: Record<ReportName, ReportAnswer>): DashboardAnswer {
  const cash = answers['cash-position'].data as ReportData['cash-position']
  const orders = answers['order-to-cash'].data as ReportData['order-to-cash']
  const purchases = answers['procure-to-pay'].data as ReportData['procure-to-pay']
  const pipeline = answers['pipeline-to-revenue'].data as ReportData['pipeline-to-revenue']
  const cutoff = answers['cash-position'].cutoff
  const month = cutoff.toISOString().slice(0, 7)
  const entry = (name: ReportName, headline: unknown) => ({
    settled: answers[name].settled,
    headline,
  })
  return {
    cutoff,
    reports: {
      'cash-position': entry('cash-position', {
        receivables: cash.receivables,
        payables: cash.payables,
      }),
      'order-to-cash': entry(
        'order-to-cash',
        orders.currencies.map((row) => ({ currency: row.currency, confirmed: row.confirmed })),
      ),
      'procure-to-pay': entry(
        'procure-to-pay',
        purchases.currencies.map((row) => ({ currency: row.currency, committed: row.committed })),
      ),
      'pipeline-to-revenue': entry('pipeline-to-revenue', {
        month,
        won: pipeline.months
          .filter((row) => row.month === month)
          .map((row) => ({ currency: row.currency, won: row.won })),
      }),
    },
  }
}
