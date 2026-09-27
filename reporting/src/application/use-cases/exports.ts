import { createHash } from 'node:crypto'
import { uuidv7 } from 'uuidv7'
import { type Either, left, right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import {
  type Cadence,
  type ExportFormat,
  type ExportLocale,
  fileNameOf,
  nextDue,
  type Table,
  timeZoneOf,
} from '@/domain/exports'
import type { Source } from '@/domain/journal'
import {
  cutoffOf,
  REPORTS,
  type ReportFilter,
  type ReportName,
  reportFilterOf,
} from '@/domain/reports'
import { settlementOf } from '@/domain/settlement'
import type { ExportJob, ExportSchedule, ObjectStore } from '../ports/export-store'
import type { Clock } from '../ports/journal-store'
import type { CommandScope, ReportingCommands, ReportReads } from '../ports/report-store'
import { reportTable } from '../report-table'
import { audit, type CommandContext, type IdempotentContext, once } from './commands'
import type { FilterInput } from './manage-saved-filters'

export type Render = (
  format: ExportFormat,
  metadata: readonly (readonly [string, string])[],
  table: Table,
  locale: ExportLocale,
) => Buffer

/** What the caller may do beyond their own exports: an administrator sees everyone's. */
export interface ExportPermissions {
  readonly administer: boolean
}

type Failure = InvalidInputError | ResourceNotFoundError | ConflictError

const MISSING_JOB = () => new ResourceNotFoundError('Export')
const MISSING_SCHEDULE = () => new ResourceNotFoundError('Export schedule')

export function filterText(filter: ReportFilter): string {
  const parts = [
    filter.currency ? `currency=${filter.currency}` : null,
    filter.from ? `from=${filter.from}` : null,
    filter.to ? `to=${filter.to}` : null,
  ].filter((part) => part !== null)
  return parts.length > 0 ? parts.join('; ') : 'none'
}

/** Asks for a report as a file; a worker writes it (ADR 0059, Phase 63). */
export class RequestExportUseCase {
  constructor(
    private readonly commands: ReportingCommands,
    private readonly clock: Clock,
  ) {}

  execute(
    context: IdempotentContext,
    input: {
      readonly report: ReportName
      readonly filter: FilterInput
      readonly cutoff: Date | null
      readonly format: ExportFormat
      readonly locale: ExportLocale
    },
  ): Promise<Either<Failure, ExportJob>> {
    return once(
      this.commands,
      context,
      'export.request',
      { ...input, cutoff: input.cutoff?.toISOString() ?? null },
      async (scope) => {
        const now = this.clock.now()
        const cutoff = cutoffOf(input.cutoff, now)
        if (cutoff.isLeft()) return left(cutoff.value)
        const filter = reportFilterOf(input.filter)
        if (filter.isLeft()) return left(filter.value)
        const job = requestedJob({
          requestedBy: context.actor,
          report: input.report,
          filter: filter.value,
          cutoff: cutoff.value,
          format: input.format,
          locale: input.locale,
          scheduleId: null,
          now,
        })
        await scope.jobs.insert(job)
        await audit(scope, context, {
          action: 'export.requested',
          subjectType: 'export',
          subjectId: job.jobId,
          occurredAt: now,
          details: { report: job.report, format: job.format, cutoff: job.cutoff },
        })
        return right(job)
      },
    )
  }
}

function requestedJob(input: {
  readonly requestedBy: string
  readonly report: ReportName
  readonly filter: ReportFilter
  readonly cutoff: Date
  readonly format: ExportFormat
  readonly locale: ExportLocale
  readonly scheduleId: string | null
  readonly now: Date
}): ExportJob {
  return {
    jobId: uuidv7(),
    requestedBy: input.requestedBy,
    report: input.report,
    filter: input.filter,
    cutoff: input.cutoff,
    format: input.format,
    locale: input.locale,
    scheduleId: input.scheduleId,
    status: 'requested',
    settled: null,
    rows: null,
    bytes: null,
    sha256: null,
    objectKey: null,
    failure: null,
    requestedAt: input.now,
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
  }
}

export interface ExportWorkOptions {
  /** How long a written file is kept. */
  readonly retentionMs: number
  /** A running job older than this has lost its worker and is taken again. */
  readonly leaseMs: number
  /** How long a scheduled run waits for its cutoff to settle before running anyway. */
  readonly settleGraceMs: number
  /** Jobs, schedules or expiries one tenant's pass handles at most. */
  readonly batch: number
}

/**
 * The export worker's work for one tenant: due schedules become jobs, requested jobs
 * become files, expired files are removed (Phase 63). Each step claims its rows with
 * `FOR UPDATE SKIP LOCKED`, so two workers never do the same one.
 */
export class ExportWorkUseCase {
  constructor(
    private readonly commands: ReportingCommands,
    private readonly reads: ReportReads,
    private readonly store: ObjectStore,
    private readonly render: Render,
    private readonly clock: Clock,
    private readonly options: ExportWorkOptions,
  ) {}

  async runTenant(tenantId: string) {
    const scheduled = await this.runDueSchedules(tenantId)
    let written = 0
    let failed = 0
    for (let index = 0; index < this.options.batch; index += 1) {
      const outcome = await this.processNext(tenantId)
      if (outcome === 'none') break
      if (outcome === 'ready') written += 1
      else failed += 1
    }
    const expired = await this.expire(tenantId)
    return { scheduled, written, failed, expired }
  }

  /** Every overdue instant becomes one run, in order, once its cutoff settles or waits too long. */
  async runDueSchedules(tenantId: string): Promise<number> {
    const now = this.clock.now()
    const watermarks = await this.reads.watermarks(tenantId)
    return this.commands.inTenant(tenantId, async (scope) => {
      let created = 0
      for (const schedule of await scope.schedules.claimDue(now, this.options.batch))
        created += await this.catchUp(scope, schedule, watermarks, now)
      return created
    })
  }

  /** The runs one schedule owes up to now; it then waits at its next due instant. */
  private async catchUp(
    scope: CommandScope,
    schedule: ExportSchedule,
    watermarks: ReadonlyMap<Source, Date | null>,
    now: Date,
  ): Promise<number> {
    let created = 0
    let due = schedule.nextDueAt
    while (due.getTime() <= now.getTime()) {
      const settled = settlementOf(watermarks, due, REPORTS[schedule.report].sources).settled
      if (!settled && now.getTime() - due.getTime() < this.options.settleGraceMs) break
      const job = requestedJob({
        ...schedule,
        requestedBy: schedule.ownerId,
        cutoff: due,
        scheduleId: schedule.scheduleId,
        now,
      })
      if (await scope.jobs.insert(job)) created += 1
      due = nextDue(schedule.cadence, schedule.timeZone, due)
    }
    if (due.getTime() !== schedule.nextDueAt.getTime())
      await scope.schedules.update({ ...schedule, nextDueAt: due, updatedAt: now })
    return created
  }

  async processNext(tenantId: string): Promise<'ready' | 'failed' | 'none'> {
    const now = this.clock.now()
    const claimed = await this.commands.inTenant(tenantId, async (scope) => {
      const job = await scope.jobs.claimNext(new Date(now.getTime() - this.options.leaseMs))
      if (!job) return null
      const running: ExportJob = { ...job, status: 'running', startedAt: now }
      await scope.jobs.update(running)
      return running
    })
    if (!claimed) return 'none'
    let finished: ExportJob
    try {
      finished = await this.write(tenantId, claimed)
    } catch {
      finished = {
        ...claimed,
        status: 'failed',
        failure: 'the file could not be written',
        finishedAt: this.clock.now(),
      }
    }
    await this.commands.inTenant(tenantId, async (scope) => {
      await scope.jobs.update(finished)
      await scope.audit.append({
        actor: 'reporting:export-worker',
        action: finished.status === 'ready' ? 'export.written' : 'export.failed',
        subjectType: 'export',
        subjectId: finished.jobId,
        occurredAt: finished.finishedAt ?? now,
        requestId: null,
        details: { rows: finished.rows, bytes: finished.bytes, settled: finished.settled },
      })
    })
    return finished.status === 'ready' ? 'ready' : 'failed'
  }

  private async write(tenantId: string, job: ExportJob): Promise<ExportJob> {
    const watermarks = await this.reads.watermarks(tenantId)
    const settled = settlementOf(watermarks, job.cutoff, REPORTS[job.report].sources).settled
    const data = await this.reads.report(tenantId, job.report, job.cutoff, job.filter)
    const table = reportTable(job.report, data)
    const now = this.clock.now()
    const metadata: [string, string][] = [
      ['report', job.report],
      ['cutoff', job.cutoff.toISOString()],
      ['settled', String(settled)],
      ['filter', filterText(job.filter)],
      ['generated_at', now.toISOString()],
      ['locale', job.locale],
      ...(job.scheduleId ? ([['schedule', job.scheduleId]] as [string, string][]) : []),
    ]
    const bytes = this.render(job.format, metadata, table, job.locale)
    const objectKey = `exports/${tenantId}/${job.jobId}.${job.format}`
    await this.store.put(objectKey, bytes, job.format)
    return {
      ...job,
      status: 'ready',
      settled,
      rows: table.rows.length,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      objectKey,
      finishedAt: now,
      expiresAt: new Date(now.getTime() + this.options.retentionMs),
    }
  }

  /** Files past retention are removed; the job row stays, as history. */
  async expire(tenantId: string): Promise<number> {
    const now = this.clock.now()
    return this.commands.inTenant(tenantId, async (scope) => {
      const expired = await scope.jobs.claimExpired(now, this.options.batch)
      for (const job of expired) {
        if (job.objectKey) await this.store.remove(job.objectKey)
        await scope.jobs.update({ ...job, status: 'expired', objectKey: null })
      }
      return expired.length
    })
  }
}

/** A person's own exports: listed, and handed out through short-lived signed links. */
export class ReadExportsUseCase {
  constructor(
    private readonly commands: ReportingCommands,
    private readonly store: ObjectStore,
  ) {}

  list(context: CommandContext, permissions: ExportPermissions, limit: number) {
    return this.commands.inTenant(context.tenantId, (scope) =>
      scope.jobs.list(permissions.administer ? null : context.actor, limit),
    )
  }

  async find(
    context: CommandContext,
    permissions: ExportPermissions,
    jobId: string,
  ): Promise<Either<ResourceNotFoundError, ExportJob>> {
    const job = await this.commands.inTenant(context.tenantId, (scope) => scope.jobs.find(jobId))
    if (!job || (!permissions.administer && job.requestedBy !== context.actor))
      return left(MISSING_JOB())
    return right(job)
  }

  /** A ready file, for a link whose signature and expiry the caller already checked. */
  async file(tenantId: string, jobId: string) {
    const job = await this.commands.inTenant(tenantId, (scope) => scope.jobs.find(jobId))
    if (job?.status !== 'ready' || !job.objectKey) return null
    return {
      bytes: await this.store.get(job.objectKey),
      name: fileNameOf(job.report, job.cutoff, job.format),
      format: job.format,
      sha256: job.sha256,
    }
  }
}

const MAX_BACKFILL_MS = 31 * 24 * 60 * 60 * 1000

/** Schedules of exports, owned by the person who made them (Phase 63). */
export class ManageExportSchedulesUseCase {
  constructor(
    private readonly commands: ReportingCommands,
    private readonly clock: Clock,
  ) {}

  create(
    context: IdempotentContext,
    input: {
      readonly report: ReportName
      readonly filter: FilterInput
      readonly format: ExportFormat
      readonly locale: ExportLocale
      readonly cadence: Cadence
      readonly timeZone: string
      /** The first run is the first due instant after this; at most 31 days back. */
      readonly since: Date | null
    },
  ): Promise<Either<Failure, ExportSchedule>> {
    return once(
      this.commands,
      context,
      'export-schedule.create',
      { ...input, since: input.since?.toISOString() ?? null },
      async (scope) => {
        const now = this.clock.now()
        const filter = reportFilterOf(input.filter)
        if (filter.isLeft()) return left(filter.value)
        const timeZone = timeZoneOf(input.timeZone)
        if (timeZone.isLeft()) return left(timeZone.value)
        const since = input.since ?? now
        if (since.getTime() > now.getTime() || now.getTime() - since.getTime() > MAX_BACKFILL_MS)
          return left(new InvalidInputError('since', 'must be within the last 31 days'))
        const schedule: ExportSchedule = {
          scheduleId: uuidv7(),
          ownerId: context.actor,
          report: input.report,
          filter: filter.value,
          format: input.format,
          locale: input.locale,
          cadence: input.cadence,
          timeZone: timeZone.value,
          nextDueAt: nextDue(input.cadence, timeZone.value, since),
          active: true,
          createdAt: now,
          updatedAt: now,
        }
        await scope.schedules.insert(schedule)
        await audit(scope, context, {
          action: 'export-schedule.created',
          subjectType: 'export-schedule',
          subjectId: schedule.scheduleId,
          occurredAt: now,
          details: {
            report: schedule.report,
            cadence: schedule.cadence,
            timeZone: schedule.timeZone,
          },
        })
        return right(schedule)
      },
    )
  }

  list(context: CommandContext, permissions: ExportPermissions) {
    return this.commands.inTenant(context.tenantId, (scope) =>
      scope.schedules.list(permissions.administer ? null : context.actor),
    )
  }

  /** Pausing stops new runs; resuming catches up from where it stopped. */
  setActive(
    context: CommandContext,
    permissions: ExportPermissions,
    scheduleId: string,
    active: boolean,
  ): Promise<Either<Failure, ExportSchedule>> {
    return this.commands.inTenant(
      context.tenantId,
      async (scope): Promise<Either<Failure, ExportSchedule>> => {
        const current = await scope.schedules.find(scheduleId)
        if (!current || (!permissions.administer && current.ownerId !== context.actor))
          return left(MISSING_SCHEDULE())
        const now = this.clock.now()
        const next = { ...current, active, updatedAt: now }
        await scope.schedules.update(next)
        await audit(scope, context, {
          action: active ? 'export-schedule.resumed' : 'export-schedule.paused',
          subjectType: 'export-schedule',
          subjectId: scheduleId,
          occurredAt: now,
          details: {},
        })
        return right(next)
      },
    )
  }

  /** The runs already made are kept. */
  remove(
    context: CommandContext,
    permissions: ExportPermissions,
    scheduleId: string,
  ): Promise<Either<Failure, { readonly scheduleId: string }>> {
    return this.commands.inTenant(
      context.tenantId,
      async (scope): Promise<Either<Failure, { readonly scheduleId: string }>> => {
        const current = await scope.schedules.find(scheduleId)
        if (!current || (!permissions.administer && current.ownerId !== context.actor))
          return left(MISSING_SCHEDULE())
        await scope.schedules.remove(scheduleId)
        await audit(scope, context, {
          action: 'export-schedule.removed',
          subjectType: 'export-schedule',
          subjectId: scheduleId,
          occurredAt: this.clock.now(),
          details: { report: current.report },
        })
        return right({ scheduleId })
      },
    )
  }
}
