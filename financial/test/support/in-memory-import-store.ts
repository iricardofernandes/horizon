import {
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

type Row = { line: number; cells: readonly string[] | null; state: RowState; issues: RowIssue[] }
type Stored = { job: ImportJob; rows: Row[]; leaseUntil: Date | null }

const OPEN: readonly ImportState[] = ['uploaded', 'validated', 'previewed']

/** The import store as the SQL one behaves, one tenant scope per job, for unit tests. */
export class InMemoryImportStore extends ImportStore {
  readonly jobs = new Map<string, Stored>()
  readonly references = new Map<string, string>()

  private stored(tenantId: string, jobId: string): Stored | null {
    const stored = this.jobs.get(jobId)
    return stored && stored.job.tenantId === tenantId ? stored : null
  }

  private update(stored: Stored, patch: Partial<ImportJob>): void {
    stored.job = { ...stored.job, ...patch }
  }

  async create(job: ImportJob, rows: readonly SourceRow[]): Promise<void> {
    this.jobs.set(job.id, {
      job,
      rows: rows.map((row) => ({ line: row.line, cells: row.cells, state: 'pending', issues: [] })),
      leaseUntil: null,
    })
  }

  async findByKey(tenantId: string, kind: string, jobKey: string): Promise<ImportJob | null> {
    const found = [...this.jobs.values()].find(
      ({ job }) => job.tenantId === tenantId && job.kind === kind && job.jobKey === jobKey,
    )
    return found?.job ?? null
  }

  async find(tenantId: string, jobId: string): Promise<ImportJob | null> {
    return this.stored(tenantId, jobId)?.job ?? null
  }

  async list(tenantId: string, filter: { kind?: string | undefined; limit: number }) {
    return [...this.jobs.values()]
      .map(({ job }) => job)
      .filter((job) => job.tenantId === tenantId && (!filter.kind || job.kind === filter.kind))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit)
  }

  async counts(tenantId: string, jobId: string): Promise<RowCounts> {
    const counts: Record<RowState, number> = { ...EMPTY_COUNTS }
    for (const row of this.stored(tenantId, jobId)?.rows ?? []) counts[row.state] += 1
    return counts
  }

  async rows(
    tenantId: string,
    jobId: string,
    filter: { states?: readonly RowState[]; limit?: number },
  ): Promise<readonly StoredRow[]> {
    return (this.stored(tenantId, jobId)?.rows ?? [])
      .filter((row) => !filter.states || filter.states.includes(row.state))
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
      .map((row) => ({
        line: row.line,
        cells: row.cells ?? [],
        state: row.state,
        issues: row.issues,
        reference: this.references.get(`${jobId}:${row.line}`) ?? null,
      }))
  }

  async validated(
    tenantId: string,
    jobId: string,
    mapping: ImportMapping,
    verdicts: readonly RowVerdict[],
    now: Date,
  ): Promise<boolean> {
    const stored = this.stored(tenantId, jobId)
    if (!stored || !OPEN.includes(stored.job.status)) return false
    this.update(stored, { status: 'validated', mapping, validatedAt: now, updatedAt: now })
    for (const verdict of verdicts) {
      const row = stored.rows.find((candidate) => candidate.line === verdict.line)
      if (row) Object.assign(row, { state: verdict.state, issues: [...verdict.issues] })
    }
    return true
  }

  async transition(
    tenantId: string,
    jobId: string,
    from: readonly ImportState[],
    to: ImportState,
    now: Date,
  ): Promise<boolean> {
    const stored = this.stored(tenantId, jobId)
    if (!stored || !from.includes(stored.job.status)) return false
    this.update(stored, { status: to, updatedAt: now })
    return true
  }

  async cancel(tenantId: string, jobId: string, now: Date, failuresUntil: Date) {
    const stored = this.stored(tenantId, jobId)
    if (!stored || ![...OPEN, 'running'].includes(stored.job.status)) return false
    this.cancelStored(stored, now, failuresUntil)
    return true
  }

  private cancelStored(stored: Stored, now: Date, failuresUntil: Date): void {
    for (const row of stored.rows)
      if (row.state === 'pending' || row.state === 'valid') row.state = 'cancelled'
    const failed = stored.rows.some((row) => row.state === 'invalid' || row.state === 'rejected')
    this.update(stored, {
      status: 'cancelled',
      finishedAt: now,
      updatedAt: now,
      failuresUntil: failed ? failuresUntil : null,
      purgedAt: failed ? null : now,
    })
    stored.leaseUntil = null
    this.clear(stored, !failed)
  }

  async claim(tenantId: string, now: Date, leaseUntil: Date): Promise<ImportJob | null> {
    const found = [...this.jobs.values()].find(
      (stored) =>
        stored.job.tenantId === tenantId &&
        stored.job.status === 'running' &&
        (stored.leaseUntil === null || stored.leaseUntil <= now),
    )
    if (!found) return null
    found.leaseUntil = leaseUntil
    return found.job
  }

  async renew(tenantId: string, jobId: string, leaseUntil: Date): Promise<boolean> {
    const stored = this.stored(tenantId, jobId)
    if (stored?.job.status !== 'running') return false
    stored.leaseUntil = leaseUntil
    return true
  }

  /** What the write transaction does: false when the row is no longer waiting. */
  markInTransaction(tenantId: string, jobId: string, line: number): boolean {
    const row = this.stored(tenantId, jobId)?.rows.find((candidate) => candidate.line === line)
    if (row?.state !== 'valid') return false
    row.state = 'written'
    return true
  }

  async markWritten(tenantId: string, jobId: string, line: number, reference: string) {
    const row = this.stored(tenantId, jobId)?.rows.find((candidate) => candidate.line === line)
    if (!row) return
    const unreferenced = !this.references.has(`${jobId}:${line}`)
    if (row.state === 'valid' || (row.state === 'written' && unreferenced)) {
      row.state = 'written'
      this.references.set(`${jobId}:${line}`, reference)
    }
  }

  async markRejected(tenantId: string, jobId: string, line: number, issues: readonly RowIssue[]) {
    const row = this.stored(tenantId, jobId)?.rows.find((candidate) => candidate.line === line)
    if (row?.state === 'valid') Object.assign(row, { state: 'rejected', issues: [...issues] })
  }

  async finish(
    tenantId: string,
    jobId: string,
    status: ImportState,
    now: Date,
    failuresUntil: Date | null,
  ): Promise<void> {
    const stored = this.stored(tenantId, jobId)
    if (stored?.job.status !== 'running') return
    this.update(stored, {
      status,
      finishedAt: now,
      updatedAt: now,
      failuresUntil,
      purgedAt: failuresUntil === null ? now : null,
    })
    stored.leaseUntil = null
    this.clear(stored, failuresUntil === null)
  }

  async purgeExpired(tenantId: string, now: Date): Promise<number> {
    let purged = 0
    for (const stored of this.jobs.values()) {
      const { job } = stored
      if (job.tenantId !== tenantId || job.purgedAt || !job.failuresUntil) continue
      if (job.failuresUntil > now) continue
      this.update(stored, { purgedAt: now })
      this.clear(stored, true)
      purged += 1
    }
    return purged
  }

  async abandonStale(tenantId: string, before: Date, now: Date, failuresUntil: Date) {
    let abandoned = 0
    for (const stored of this.jobs.values()) {
      const { job } = stored
      if (job.tenantId !== tenantId || !OPEN.includes(job.status) || job.updatedAt >= before)
        continue
      this.cancelStored(stored, now, failuresUntil)
      abandoned += 1
    }
    return abandoned
  }

  private clear(stored: Stored, everyRow: boolean): void {
    for (const row of stored.rows)
      if (everyRow || row.state === 'written' || row.state === 'cancelled') row.cells = null
  }
}
