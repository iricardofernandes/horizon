import { randomBytes, randomUUID } from 'node:crypto'
import { type SQL, sql } from 'drizzle-orm'
import {
  ImportRowTakenError,
  ImportStore,
  type RowVerdict,
  type SourceRow,
  type StoredRow,
} from '@/application/imports/ports'
import {
  EMPTY_COUNTS,
  type ImportJob,
  type ImportMapping,
  type ImportState,
  type RowCounts,
  type RowIssue,
  type RowState,
} from '@/domain/imports/import-job'

export type SqlRun = (query: SQL) => Promise<readonly Record<string, unknown>[]>

/** A tenant transaction that speaks SQL, and the one the current write is running in. */
export interface TenantSql {
  inTenantSql<T>(tenantId: string, work: (run: SqlRun) => Promise<T>): Promise<T>
  currentSql(): SqlRun | null
}

/** How a row's cells are kept: sealed under the job's key where they are personal data. */
export interface RowCodec {
  newKey(): string | null
  seal(key: string | null, scope: RowScope, cells: readonly string[]): string
  open(key: string | null, scope: RowScope, stored: string): readonly string[]
}

export interface RowScope {
  readonly tenantId: string
  readonly jobId: string
  readonly line: number
}

/** Cells as JSON text, for modules whose rows hold no personal data. */
export const PLAIN_ROWS: RowCodec = {
  newKey: () => null,
  seal: (_key, _scope, cells) => JSON.stringify(cells),
  open: (_key, _scope, stored) => JSON.parse(stored) as string[],
}

const INSERT_CHUNK = 500
const OPEN: readonly ImportState[] = ['uploaded', 'validated', 'previewed']
const CANCELLABLE: readonly ImportState[] = [...OPEN, 'running']

const list = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )

function dateOf(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value : new Date(String(value))
}

function jsonOf<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}

function jobOf(row: Record<string, unknown>): ImportJob {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    kind: String(row.kind),
    jobKey: String(row.job_key),
    status: row.status as ImportState,
    fileName: String(row.file_name),
    format: row.format as ImportJob['format'],
    locale: row.locale as ImportJob['locale'],
    delimiter: String(row.delimiter),
    sha256: String(row.sha256),
    columns: jsonOf<string[]>(row.columns),
    mapping: row.mapping === null ? null : jsonOf<ImportMapping>(row.mapping),
    validatedAt: dateOf(row.validated_at),
    requestedBy: String(row.requested_by),
    createdAt: dateOf(row.created_at) as Date,
    updatedAt: dateOf(row.updated_at) as Date,
    finishedAt: dateOf(row.finished_at),
    failuresUntil: dateOf(row.failures_until),
    purgedAt: dateOf(row.purged_at),
  }
}

/** Import jobs and rows, always inside one tenant's transaction (ADR 0017). */
export class SqlImportStore extends ImportStore {
  constructor(
    private readonly database: TenantSql,
    private readonly codec: RowCodec,
    /** The owning module, which names the event a finished job publishes (Phase 66). */
    private readonly module: string,
  ) {
    super()
  }

  create(job: ImportJob, rows: readonly SourceRow[]): Promise<void> {
    const key = this.codec.newKey()
    return this.database.inTenantSql(job.tenantId, async (run) => {
      // A workspace's first import may be the first thing this module hears of it.
      await run(sql`insert into tenants (id) values (${job.tenantId}) on conflict do nothing`)
      await run(sql`
        insert into import_jobs (id, tenant_id, kind, job_key, status, file_name, format, locale,
          delimiter, sha256, columns, mapping, requested_by, data_key, created_at, updated_at)
        values (${job.id}, ${job.tenantId}, ${job.kind}, ${job.jobKey}, ${job.status},
          ${job.fileName}, ${job.format}, ${job.locale}, ${job.delimiter}, ${job.sha256},
          ${JSON.stringify(job.columns)}::jsonb, ${JSON.stringify(job.mapping)}::jsonb,
          ${job.requestedBy}, ${key}, ${job.createdAt.toISOString()}::timestamptz,
          ${job.updatedAt.toISOString()}::timestamptz)`)
      for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
        const values = rows.slice(start, start + INSERT_CHUNK).map((row) => {
          const cells = this.codec.seal(
            key,
            { tenantId: job.tenantId, jobId: job.id, line: row.line },
            row.cells,
          )
          return sql`(${job.tenantId}, ${job.id}, ${row.line}, 'pending', ${cells})`
        })
        await run(sql`
          insert into import_rows (tenant_id, job_id, line, state, cells)
          values ${sql.join(values, sql`, `)}`)
      }
    })
  }

  findByKey(tenantId: string, kind: string, jobKey: string): Promise<ImportJob | null> {
    return this.database.inTenantSql(tenantId, async (run) => {
      const [row] = await run(
        sql`select * from import_jobs where kind = ${kind} and job_key = ${jobKey}`,
      )
      return row ? jobOf(row) : null
    })
  }

  find(tenantId: string, jobId: string): Promise<ImportJob | null> {
    return this.database.inTenantSql(tenantId, async (run) => {
      const [row] = await run(sql`select * from import_jobs where id = ${jobId}`)
      return row ? jobOf(row) : null
    })
  }

  list(
    tenantId: string,
    filter: { readonly kind?: string | undefined; readonly limit: number },
  ): Promise<readonly ImportJob[]> {
    return this.database.inTenantSql(tenantId, async (run) => {
      const rows = await run(sql`
        select * from import_jobs
        ${filter.kind === undefined ? sql`` : sql`where kind = ${filter.kind}`}
        order by created_at desc limit ${filter.limit}`)
      return rows.map(jobOf)
    })
  }

  counts(tenantId: string, jobId: string): Promise<RowCounts> {
    return this.database.inTenantSql(tenantId, async (run) => {
      const rows = await run(sql`
        select state, count(*)::int as count from import_rows
        where job_id = ${jobId} group by state`)
      const counts: Record<RowState, number> = { ...EMPTY_COUNTS }
      for (const row of rows) counts[row.state as RowState] = Number(row.count)
      return counts
    })
  }

  rows(
    tenantId: string,
    jobId: string,
    filter: { readonly states?: readonly RowState[]; readonly limit?: number },
  ): Promise<readonly StoredRow[]> {
    return this.database.inTenantSql(tenantId, async (run) => {
      const [job] = await run(sql`select data_key from import_jobs where id = ${jobId}`)
      if (!job) return []
      const key = (job.data_key as string | null) ?? null
      const rows = await run(sql`
        select line, state, cells, issues, reference from import_rows
        where job_id = ${jobId}
        ${filter.states ? sql`and state in (${list(filter.states)})` : sql``}
        order by line
        ${filter.limit === undefined ? sql`` : sql`limit ${filter.limit}`}`)
      return rows.map((row) => {
        const line = Number(row.line)
        const stored = row.cells as string | null
        return {
          line,
          cells: stored === null ? [] : this.codec.open(key, { tenantId, jobId, line }, stored),
          state: row.state as RowState,
          issues: jsonOf<RowIssue[]>(row.issues),
          reference: (row.reference as string | null) ?? null,
        }
      })
    })
  }

  validated(
    tenantId: string,
    jobId: string,
    mapping: ImportMapping,
    verdicts: readonly RowVerdict[],
    now: Date,
  ): Promise<boolean> {
    return this.database.inTenantSql(tenantId, async (run) => {
      const at = now.toISOString()
      const updated = await run(sql`
        update import_jobs set status = 'validated', mapping = ${JSON.stringify(mapping)}::jsonb,
          validated_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
        where id = ${jobId} and status in (${list(OPEN)}) returning id`)
      if (updated.length === 0) return false
      for (let start = 0; start < verdicts.length; start += INSERT_CHUNK) {
        const values = verdicts
          .slice(start, start + INSERT_CHUNK)
          .map(
            (verdict) =>
              sql`(${verdict.line}::int, ${verdict.state}, ${JSON.stringify(verdict.issues)}::jsonb)`,
          )
        await run(sql`
          update import_rows as r set state = v.state, issues = v.issues
          from (values ${sql.join(values, sql`, `)}) as v(line, state, issues)
          where r.job_id = ${jobId} and r.line = v.line`)
      }
      return true
    })
  }

  transition(
    tenantId: string,
    jobId: string,
    from: readonly ImportState[],
    to: ImportState,
    now: Date,
  ): Promise<boolean> {
    return this.database.inTenantSql(tenantId, async (run) => {
      const updated = await run(sql`
        update import_jobs set status = ${to}, updated_at = ${now.toISOString()}::timestamptz
        where id = ${jobId} and status in (${list(from)}) returning id`)
      return updated.length > 0
    })
  }

  cancel(tenantId: string, jobId: string, now: Date, failuresUntil: Date): Promise<boolean> {
    return this.database.inTenantSql(tenantId, async (run) => {
      if (!(await cancelJob(run, jobId, now, failuresUntil, CANCELLABLE))) return false
      await announceFinished(run, this.module, tenantId, jobId, now)
      return true
    })
  }

  claim(tenantId: string, now: Date, leaseUntil: Date): Promise<ImportJob | null> {
    return this.database.inTenantSql(tenantId, async (run) => {
      const [row] = await run(sql`
        update import_jobs set lease_until = ${leaseUntil.toISOString()}::timestamptz
        where id = (
          select id from import_jobs
          where status = 'running'
            and (lease_until is null or lease_until <= ${now.toISOString()}::timestamptz)
          order by created_at limit 1
          for update skip locked)
        returning *`)
      return row ? jobOf(row) : null
    })
  }

  renew(tenantId: string, jobId: string, leaseUntil: Date): Promise<boolean> {
    return this.database.inTenantSql(tenantId, async (run) => {
      const updated = await run(sql`
        update import_jobs set lease_until = ${leaseUntil.toISOString()}::timestamptz
        where id = ${jobId} and status = 'running' returning id`)
      return updated.length > 0
    })
  }

  markWritten(tenantId: string, jobId: string, line: number, reference: string): Promise<void> {
    return this.database.inTenantSql(tenantId, async (run) => {
      await run(sql`
        update import_rows set state = 'written', reference = ${reference}
        where job_id = ${jobId} and line = ${line}
          and (state = 'valid' or (state = 'written' and reference is null))`)
    })
  }

  markRejected(
    tenantId: string,
    jobId: string,
    line: number,
    issues: readonly RowIssue[],
  ): Promise<void> {
    return this.database.inTenantSql(tenantId, async (run) => {
      await run(sql`
        update import_rows set state = 'rejected', issues = ${JSON.stringify(issues)}::jsonb
        where job_id = ${jobId} and line = ${line} and state = 'valid'`)
    })
  }

  finish(
    tenantId: string,
    jobId: string,
    status: ImportState,
    now: Date,
    failuresUntil: Date | null,
  ): Promise<void> {
    return this.database.inTenantSql(tenantId, async (run) => {
      const at = now.toISOString()
      const until = failuresUntil?.toISOString() ?? null
      const updated = await run(sql`
        update import_jobs set status = ${status}, finished_at = ${at}::timestamptz,
          updated_at = ${at}::timestamptz, lease_until = null,
          failures_until = ${until}::timestamptz,
          purged_at = case when ${until}::timestamptz is null then ${at}::timestamptz end,
          data_key = case when ${until}::timestamptz is null then null else data_key end
        where id = ${jobId} and status = 'running' returning id`)
      if (updated.length === 0) return
      await clearCells(run, jobId, until === null)
      await announceFinished(run, this.module, tenantId, jobId, now)
    })
  }

  purgeExpired(tenantId: string, now: Date): Promise<number> {
    return this.database.inTenantSql(tenantId, async (run) => {
      const at = now.toISOString()
      const jobs = await run(sql`
        update import_jobs set purged_at = ${at}::timestamptz, data_key = null
        where purged_at is null and failures_until <= ${at}::timestamptz returning id`)
      for (const job of jobs) await clearCells(run, String(job.id), true)
      return jobs.length
    })
  }

  abandonStale(tenantId: string, before: Date, now: Date, failuresUntil: Date): Promise<number> {
    return this.database.inTenantSql(tenantId, async (run) => {
      const stale = await run(sql`
        select id from import_jobs
        where status in (${list(OPEN)}) and updated_at < ${before.toISOString()}::timestamptz
        for update skip locked`)
      let abandoned = 0
      for (const job of stale)
        if (await cancelJob(run, String(job.id), now, failuresUntil, OPEN)) {
          await announceFinished(run, this.module, tenantId, String(job.id), now)
          abandoned += 1
        }
      return abandoned
    })
  }
}

/**
 * Tells whoever asked that their job ended (Phase 66): `<module>.import.finished`, in the
 * transaction that ended it, with the counts and never a row.
 */
async function announceFinished(
  run: SqlRun,
  module: string,
  tenantId: string,
  jobId: string,
  now: Date,
): Promise<void> {
  const [job] = await run(sql`
    select j.kind, j.status, j.requested_by,
      count(r.line)::int as total,
      count(r.line) filter (where r.state = 'written')::int as written,
      count(r.line) filter (where r.state in ('invalid', 'rejected'))::int as failed,
      count(r.line) filter (where r.state = 'cancelled')::int as cancelled
    from import_jobs j left join import_rows r on r.job_id = j.id
    where j.id = ${jobId}
    group by j.kind, j.status, j.requested_by`)
  if (!job) return
  const payload = {
    jobId,
    kind: String(job.kind),
    status: String(job.status),
    requestedBy: String(job.requested_by),
    total: Number(job.total),
    written: Number(job.written),
    failed: Number(job.failed),
    cancelled: Number(job.cancelled),
  }
  const id = randomUUID()
  await run(sql`
    insert into outbox (id, tenant_id, event_id, event_type, event_version, occurred_at,
      trace_id, payload)
    values (${id}, ${tenantId}, ${id}, ${`${module}.import.finished`}, 1,
      ${now.toISOString()}::timestamptz, ${randomBytes(16).toString('hex')},
      ${JSON.stringify(payload)}::jsonb)`)
}

async function clearCells(run: SqlRun, jobId: string, everyRow: boolean): Promise<void> {
  await run(sql`
    update import_rows set cells = null
    where job_id = ${jobId} and cells is not null
      ${everyRow ? sql`` : sql`and state in ('written', 'cancelled')`}`)
}

/** Cancels a job and the rows it had not written; failures stay until retention. */
async function cancelJob(
  run: SqlRun,
  jobId: string,
  now: Date,
  failuresUntil: Date,
  from: readonly ImportState[],
): Promise<boolean> {
  const at = now.toISOString()
  const updated = await run(sql`
    update import_jobs set status = 'cancelled', finished_at = ${at}::timestamptz,
      updated_at = ${at}::timestamptz, lease_until = null
    where id = ${jobId} and status in (${list(from)}) returning id`)
  if (updated.length === 0) return false
  await run(sql`
    update import_rows set state = 'cancelled'
    where job_id = ${jobId} and state in ('pending', 'valid')`)
  const [failed] = await run(sql`
    select count(*)::int as count from import_rows
    where job_id = ${jobId} and state in ('invalid', 'rejected')`)
  const hasFailures = Number(failed?.count ?? 0) > 0
  await run(sql`
    update import_jobs set
      failures_until = ${hasFailures ? failuresUntil.toISOString() : null}::timestamptz,
      purged_at = ${hasFailures ? null : at}::timestamptz,
      data_key = case when ${hasFailures}::boolean then data_key end
    where id = ${jobId}`)
  await clearCells(run, jobId, !hasFailures)
  return true
}

/**
 * Marks a row written inside the transaction that wrote it, so the two commit together.
 * A row that is no longer waiting — cancelled, or taken by another worker — makes the
 * whole write roll back.
 */
export async function markRowInTransaction(database: TenantSql, key: RowScope): Promise<void> {
  const run = database.currentSql()
  if (!run) throw new Error('An import row is marked only inside the write transaction')
  const marked = await run(sql`
    update import_rows set state = 'written'
    where job_id = ${key.jobId} and line = ${key.line} and state = 'valid' returning line`)
  if (marked.length === 0) throw new ImportRowTakenError()
}
