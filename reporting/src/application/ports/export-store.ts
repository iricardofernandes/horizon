import type { Cadence, ExportFormat, ExportLocale, JobStatus } from '@/domain/exports'
import type { ReportFilter, ReportName } from '@/domain/reports'

export interface ExportJob {
  readonly jobId: string
  readonly requestedBy: string
  readonly report: ReportName
  readonly filter: ReportFilter
  readonly cutoff: Date
  readonly format: ExportFormat
  readonly locale: ExportLocale
  readonly scheduleId: string | null
  readonly status: JobStatus
  /** Whether the cutoff was settled for the report's sources when the file was written. */
  readonly settled: boolean | null
  readonly rows: number | null
  readonly bytes: number | null
  readonly sha256: string | null
  readonly objectKey: string | null
  readonly failure: string | null
  readonly requestedAt: Date
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
  readonly expiresAt: Date | null
}

export interface ExportSchedule {
  readonly scheduleId: string
  readonly ownerId: string
  readonly report: ReportName
  readonly filter: ReportFilter
  readonly format: ExportFormat
  readonly locale: ExportLocale
  readonly cadence: Cadence
  readonly timeZone: string
  readonly nextDueAt: Date
  readonly active: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** One tenant's export jobs and schedules, inside a transaction. */
export interface ExportScope {
  readonly jobs: {
    insert(job: ExportJob): Promise<boolean>
    find(jobId: string): Promise<ExportJob | null>
    update(job: ExportJob): Promise<void>
    list(requestedBy: string | null, limit: number): Promise<ExportJob[]>
    /** The oldest requested job, or a running one whose worker stopped: locked, skipping others. */
    claimNext(staleBefore: Date): Promise<ExportJob | null>
    /** Ready jobs past their retention, locked. */
    claimExpired(now: Date, limit: number): Promise<ExportJob[]>
  }
  readonly schedules: {
    insert(schedule: ExportSchedule): Promise<void>
    find(scheduleId: string): Promise<ExportSchedule | null>
    update(schedule: ExportSchedule): Promise<void>
    remove(scheduleId: string): Promise<void>
    list(ownerId: string | null): Promise<ExportSchedule[]>
    /** Active schedules due by now, locked, skipping ones another worker holds. */
    claimDue(now: Date, limit: number): Promise<ExportSchedule[]>
  }
}

/** Files by generated key; nothing here ever takes a key from a request. */
export abstract class ObjectStore {
  abstract put(key: string, bytes: Buffer, format: ExportFormat): Promise<void>
  abstract get(key: string): Promise<Buffer>
  abstract remove(key: string): Promise<void>
}

/** Which tenants have export work, asked as the relay role, which reads only scan columns. */
export abstract class ExportWorkScan {
  abstract tenantsWithWork(now: Date, staleBefore: Date): Promise<string[]>
}
