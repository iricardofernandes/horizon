import { and, asc, desc, eq, lte, or } from 'drizzle-orm'
import type { ExportJob, ExportSchedule, ExportScope } from '@/application/ports/export-store'
import type { Cadence, ExportFormat, ExportLocale, JobStatus } from '@/domain/exports'
import type { ReportFilter, ReportName } from '@/domain/reports'
import * as schema from './schema'
import type { Transaction } from './transaction'

function mapJob(row: typeof schema.exportJobs.$inferSelect): ExportJob {
  return {
    jobId: row.id,
    requestedBy: row.requestedBy,
    report: row.report as ReportName,
    filter: row.filter as ReportFilter,
    cutoff: row.cutoff,
    format: row.format as ExportFormat,
    locale: row.locale as ExportLocale,
    scheduleId: row.scheduleId,
    status: row.status as JobStatus,
    settled: row.settled,
    rows: row.rows,
    bytes: row.bytes,
    sha256: row.sha256,
    objectKey: row.objectKey,
    failure: row.failure,
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    expiresAt: row.expiresAt,
  }
}

function mapSchedule(row: typeof schema.exportSchedules.$inferSelect): ExportSchedule {
  return {
    scheduleId: row.id,
    ownerId: row.ownerId,
    report: row.report as ReportName,
    filter: row.filter as ReportFilter,
    format: row.format as ExportFormat,
    locale: row.locale as ExportLocale,
    cadence: row.cadence as Cadence,
    timeZone: row.timeZone,
    nextDueAt: row.nextDueAt,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function exportScope(tx: Transaction, tenantId: string): ExportScope {
  const jobs = schema.exportJobs
  const schedules = schema.exportSchedules
  return {
    jobs: {
      async insert(job) {
        const inserted = await tx
          .insert(jobs)
          .values({
            id: job.jobId,
            tenantId,
            requestedBy: job.requestedBy,
            report: job.report,
            filter: job.filter,
            cutoff: job.cutoff,
            format: job.format,
            locale: job.locale,
            scheduleId: job.scheduleId,
            status: job.status,
            requestedAt: job.requestedAt,
          })
          .onConflictDoNothing()
          .returning({ id: jobs.id })
        return inserted.length > 0
      },
      async find(jobId) {
        const [row] = await tx.select().from(jobs).where(eq(jobs.id, jobId))
        return row ? mapJob(row) : null
      },
      async update(job) {
        await tx
          .update(jobs)
          .set({
            status: job.status,
            settled: job.settled,
            rows: job.rows,
            bytes: job.bytes,
            sha256: job.sha256,
            objectKey: job.objectKey,
            failure: job.failure,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            expiresAt: job.expiresAt,
          })
          .where(eq(jobs.id, job.jobId))
      },
      async list(requestedBy, limit) {
        const rows = await tx
          .select()
          .from(jobs)
          .where(requestedBy ? eq(jobs.requestedBy, requestedBy) : undefined)
          .orderBy(desc(jobs.requestedAt))
          .limit(limit)
        return rows.map(mapJob)
      },
      async claimNext(staleBefore) {
        const [row] = await tx
          .select()
          .from(jobs)
          .where(
            or(
              eq(jobs.status, 'requested'),
              and(eq(jobs.status, 'running'), lte(jobs.startedAt, staleBefore)),
            ),
          )
          .orderBy(asc(jobs.requestedAt))
          .limit(1)
          .for('update', { skipLocked: true })
        return row ? mapJob(row) : null
      },
      async claimExpired(now, limit) {
        const rows = await tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.status, 'ready'), lte(jobs.expiresAt, now)))
          .orderBy(asc(jobs.expiresAt))
          .limit(limit)
          .for('update', { skipLocked: true })
        return rows.map(mapJob)
      },
    },
    schedules: {
      async insert(schedule) {
        await tx.insert(schedules).values({
          id: schedule.scheduleId,
          tenantId,
          ownerId: schedule.ownerId,
          report: schedule.report,
          filter: schedule.filter,
          format: schedule.format,
          locale: schedule.locale,
          cadence: schedule.cadence,
          timeZone: schedule.timeZone,
          nextDueAt: schedule.nextDueAt,
          active: schedule.active,
          createdAt: schedule.createdAt,
          updatedAt: schedule.updatedAt,
        })
      },
      async find(scheduleId) {
        const [row] = await tx.select().from(schedules).where(eq(schedules.id, scheduleId))
        return row ? mapSchedule(row) : null
      },
      async update(schedule) {
        await tx
          .update(schedules)
          .set({
            nextDueAt: schedule.nextDueAt,
            active: schedule.active,
            updatedAt: schedule.updatedAt,
          })
          .where(eq(schedules.id, schedule.scheduleId))
      },
      async remove(scheduleId) {
        await tx.delete(schedules).where(eq(schedules.id, scheduleId))
      },
      async list(ownerId) {
        const rows = await tx
          .select()
          .from(schedules)
          .where(ownerId ? eq(schedules.ownerId, ownerId) : undefined)
          .orderBy(asc(schedules.createdAt))
        return rows.map(mapSchedule)
      },
      async claimDue(now, limit) {
        const rows = await tx
          .select()
          .from(schedules)
          .where(and(eq(schedules.active, true), lte(schedules.nextDueAt, now)))
          .orderBy(asc(schedules.nextDueAt))
          .limit(limit)
          .for('update', { skipLocked: true })
        return rows.map(mapSchedule)
      },
    },
  }
}
