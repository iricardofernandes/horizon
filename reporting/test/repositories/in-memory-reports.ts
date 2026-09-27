import type { ExportJob, ExportSchedule } from '@/application/ports/export-store'
import {
  type CommandReceipt,
  type CommandScope,
  type OwnerAnswer,
  OwnerReports,
  ReportingCommands,
  ReportReads,
  type SavedFilter,
  type StoredRun,
} from '@/application/ports/report-store'
import type { ReportData } from '@/application/report-data'
import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { Source } from '@/domain/journal'
import type { ReportFilter, ReportName } from '@/domain/reports'

export const EMPTY: ReportData = {
  'cash-position': { receivables: [], payables: [], accounts: [] },
  'order-to-cash': { currencies: [] },
  'procure-to-pay': { currencies: [] },
  'pipeline-to-revenue': { months: [], quotesAccepted: [] },
}

/** Reports answered from fixed data, and the stored runs and filters, for unit tests. */
export class InMemoryReports extends ReportReads {
  data: ReportData = EMPTY
  watermarkAll: Date | null = null
  moved = new Set<Source>()
  /** Sources that start moving once an owner has been read. */
  movingOnRead = new Set<Source>()
  readonly runs: StoredRun[] = []
  readonly filters: SavedFilter[] = []
  readonly audit: string[] = []
  readonly jobs: ExportJob[] = []
  readonly schedules: ExportSchedule[] = []
  readonly requested: { name: ReportName; filter: ReportFilter }[] = []

  async report<N extends ReportName>(_: string, name: N, __: Date, filter: ReportFilter) {
    this.requested.push({ name, filter })
    return this.data[name]
  }
  async movedAfter(_: string, source: Source) {
    return this.moved.has(source)
  }
  async watermarks() {
    const sources: Source[] = ['financial', 'treasury', 'sales', 'procurement', 'crm']
    return new Map(sources.map((source) => [source, this.watermarkAll]))
  }
  async latestRun(_: string, report: ReportName, cutoff: Date) {
    return (
      this.runs
        .filter((run) => run.report === report && run.cutoff.getTime() === cutoff.getTime())
        .at(-1) ?? null
    )
  }
  async listRuns(_: string, report: ReportName, limit: number) {
    return this.runs.filter((run) => run.report === report).slice(0, limit)
  }
  async listFilters(_: string, userId: string, report: ReportName | null) {
    return this.filters.filter(
      (filter) =>
        (filter.ownerId === userId || filter.shared) && (!report || filter.report === report),
    )
  }
}

export class FakeOwners extends OwnerReports {
  readonly answers = new Map<string, OwnerAnswer>()
  readonly calls: { path: string; query: Record<string, string>; bearer: string }[] = []
  constructor(private readonly reports?: InMemoryReports) {
    super()
  }
  async read(path: string, query: Readonly<Record<string, string>>, bearer: string) {
    this.calls.push({ path, query: { ...query }, bearer })
    for (const source of this.reports?.movingOnRead ?? []) this.reports?.moved.add(source)
    return this.answers.get(path) ?? { status: 'unavailable' as const }
  }
}

export class InMemoryCommands extends ReportingCommands {
  private readonly receipts = new Map<string, { receipt: CommandReceipt; response: unknown }>()
  constructor(private readonly reports: InMemoryReports) {
    super()
  }
  private scope(): CommandScope {
    const reports = this.reports
    return {
      filters: {
        insert: async (filter) => {
          reports.filters.push(filter)
        },
        find: async (filterId) => reports.filters.find((f) => f.filterId === filterId) ?? null,
        update: async (filter) => {
          const index = reports.filters.findIndex((f) => f.filterId === filter.filterId)
          reports.filters[index] = filter
        },
        remove: async (filterId) => {
          const index = reports.filters.findIndex((f) => f.filterId === filterId)
          reports.filters.splice(index, 1)
        },
      },
      runs: {
        insert: async (run) => {
          reports.runs.push(run)
        },
      },
      audit: {
        append: async (record) => {
          reports.audit.push(record.action)
        },
      },
      jobs: {
        insert: async (job) => {
          const twin = reports.jobs.some(
            (held) =>
              held.scheduleId !== null &&
              held.scheduleId === job.scheduleId &&
              held.cutoff.getTime() === job.cutoff.getTime(),
          )
          if (twin) return false
          reports.jobs.push(job)
          return true
        },
        find: async (jobId) => reports.jobs.find((job) => job.jobId === jobId) ?? null,
        update: async (job) => {
          reports.jobs[reports.jobs.findIndex((held) => held.jobId === job.jobId)] = job
        },
        list: async (requestedBy, limit) =>
          reports.jobs
            .filter((job) => !requestedBy || job.requestedBy === requestedBy)
            .slice(0, limit),
        claimNext: async (staleBefore) =>
          reports.jobs.find(
            (job) =>
              job.status === 'requested' ||
              (job.status === 'running' &&
                (job.startedAt?.getTime() ?? 0) <= staleBefore.getTime()),
          ) ?? null,
        claimExpired: async (now, limit) =>
          reports.jobs
            .filter(
              (job) => job.status === 'ready' && (job.expiresAt?.getTime() ?? 0) <= now.getTime(),
            )
            .slice(0, limit),
      },
      schedules: {
        insert: async (schedule) => {
          reports.schedules.push(schedule)
        },
        find: async (id) => reports.schedules.find((held) => held.scheduleId === id) ?? null,
        update: async (schedule) => {
          reports.schedules[
            reports.schedules.findIndex((held) => held.scheduleId === schedule.scheduleId)
          ] = schedule
        },
        remove: async (id) => {
          reports.schedules.splice(
            reports.schedules.findIndex((held) => held.scheduleId === id),
            1,
          )
        },
        list: async (ownerId) =>
          reports.schedules.filter((held) => !ownerId || held.ownerId === ownerId),
        claimDue: async (now, limit) =>
          reports.schedules
            .filter((held) => held.active && held.nextDueAt.getTime() <= now.getTime())
            .slice(0, limit),
      },
    }
  }
  inTenant<T>(_: string, work: (scope: CommandScope) => Promise<T>) {
    return work(this.scope())
  }
  async once<E, T>(
    _: string,
    receipt: CommandReceipt,
    work: (scope: CommandScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>> {
    const previous = this.receipts.get(receipt.idempotencyKey)
    if (previous)
      return previous.receipt.fingerprint === receipt.fingerprint
        ? right(previous.response as T)
        : left(new ConflictError('this Idempotency-Key was already used for a different request'))
    const outcome = await work(this.scope())
    if (outcome.isRight())
      this.receipts.set(receipt.idempotencyKey, { receipt, response: outcome.value })
    return outcome
  }
}

/** Keeps files in memory, and can be made to fail. */
export class MemoryObjectStore {
  readonly files = new Map<string, Buffer>()
  failing = false
  async put(key: string, bytes: Buffer) {
    if (this.failing) throw new Error('storage down')
    this.files.set(key, bytes)
  }
  async get(key: string) {
    const bytes = this.files.get(key)
    if (!bytes) throw new Error('missing')
    return bytes
  }
  async remove(key: string) {
    this.files.delete(key)
  }
}
