import type { Either } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type { Source } from '@/domain/journal'
import type { CheckResult, ReportFilter, ReportName, RunOutcome } from '@/domain/reports'
import type { ReportData } from '../report-data'
import type { ExportScope } from './export-store'

export interface StoredRun {
  readonly runId: string
  readonly report: ReportName
  readonly cutoff: Date
  readonly outcome: RunOutcome
  readonly checks: readonly CheckResult[]
  readonly startedBy: string
  readonly startedAt: Date
}

export interface SavedFilter {
  readonly filterId: string
  readonly report: ReportName
  readonly name: string
  readonly filter: ReportFilter
  readonly ownerId: string
  readonly shared: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** What a report reads: the journal, the watermarks and the runs, for one tenant. */
export abstract class ReportReads {
  abstract report<N extends ReportName>(
    tenantId: string,
    name: N,
    cutoff: Date,
    filter: ReportFilter,
  ): Promise<ReportData[N]>
  /** Whether the journal holds an event of the source after the cutoff. */
  abstract movedAfter(tenantId: string, source: Source, cutoff: Date): Promise<boolean>
  abstract watermarks(tenantId: string): Promise<ReadonlyMap<Source, Date | null>>
  abstract latestRun(tenantId: string, report: ReportName, cutoff: Date): Promise<StoredRun | null>
  abstract listRuns(tenantId: string, report: ReportName, limit: number): Promise<StoredRun[]>
  abstract listFilters(
    tenantId: string,
    userId: string,
    report: ReportName | null,
  ): Promise<SavedFilter[]>
}

export type OwnerAnswer =
  | { readonly status: 'ok'; readonly body: unknown }
  | { readonly status: 'forbidden' }
  | { readonly status: 'unavailable' }

/** An owner's own report, read as the person who asked (Phase 62). */
export abstract class OwnerReports {
  abstract read(
    path: string,
    query: Readonly<Record<string, string>>,
    bearer: string,
  ): Promise<OwnerAnswer>
}

export interface AuditRecord {
  readonly actor: string
  readonly action: string
  readonly subjectType: 'reconciliation-run' | 'saved-filter' | 'export' | 'export-schedule'
  readonly subjectId: string
  readonly occurredAt: Date
  readonly requestId: string | null
  readonly details: Readonly<Record<string, unknown>>
}

export interface CommandScope extends ExportScope {
  readonly filters: {
    insert(filter: SavedFilter): Promise<void>
    find(filterId: string): Promise<SavedFilter | null>
    update(filter: SavedFilter): Promise<void>
    remove(filterId: string): Promise<void>
  }
  readonly runs: { insert(run: StoredRun): Promise<void> }
  readonly audit: { append(record: AuditRecord): Promise<void> }
}

export interface CommandReceipt {
  readonly idempotencyKey: string
  readonly command: string
  readonly fingerprint: string
}

/** Reporting's own writes: saved filters, runs and their audit, in one transaction. */
export abstract class ReportingCommands {
  abstract inTenant<T>(tenantId: string, work: (scope: CommandScope) => Promise<T>): Promise<T>
  abstract once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: CommandScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>>
}
