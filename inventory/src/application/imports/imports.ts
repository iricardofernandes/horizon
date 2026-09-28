import { createHash, randomUUID } from 'node:crypto'
import { type Either, left, right } from '@/core/either'
import {
  canCancel,
  canConfirm,
  canMap,
  canPreview,
  finishedState,
  type ImportFormat,
  type ImportJob,
  type ImportLocale,
  type ImportMapping,
  type ImportProgress,
  progressOf,
  type RowIssue,
} from '@/domain/imports/import-job'
import { checkMapping, issue, recordOf, suggestMapping } from '@/domain/imports/import-values'
import type { Clock } from '../ports/clock'
import {
  type FailuresFile,
  type ImportActor,
  type ImportFiles,
  ImportRowTakenError,
  type ImportStore,
  type RowImporter,
  type RowVerdict,
  type StoredRow,
} from './ports'

export interface ImportSettings {
  readonly maxRows: number
  readonly maxBytes: number
  readonly batchSize: number
  readonly leaseMs: number
  readonly retentionMs: number
}

export type ImportFailure =
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'not-found'; readonly message: string }
  | { readonly kind: 'gone'; readonly message: string }

export interface ImportView {
  readonly job: ImportJob
  readonly progress: ImportProgress
}

export interface ImportPreview {
  readonly view: ImportView
  readonly errors: readonly { readonly line: number; readonly reasons: readonly RowIssue[] }[]
  readonly sample: readonly {
    readonly line: number
    readonly values: Readonly<Record<string, string | null>>
  }[]
}

export interface TenantImportWork {
  readonly written: number
  readonly rejected: number
  readonly finished: number
  readonly purged: number
  readonly abandoned: number
}

const PREVIEW_ERRORS = 50
const PREVIEW_ROWS = 10
const LIST_LIMIT = 50

const invalid = (message: string): ImportFailure => ({ kind: 'invalid', message })
const notFound: ImportFailure = { kind: 'not-found', message: 'import job was not found' }
const conflict = (message: string): ImportFailure => ({ kind: 'conflict', message })

/**
 * The import job contract (ADR 0059): upload, map, preview, confirm, write in batches,
 * cancel, and download what failed. Rows reach the module only through its importers,
 * which call its own use cases.
 */
export class ImportJobs {
  readonly #importers: ReadonlyMap<string, RowImporter>

  constructor(
    private readonly store: ImportStore,
    private readonly files: ImportFiles,
    importers: readonly RowImporter[],
    private readonly clock: Clock,
    private readonly settings: ImportSettings,
  ) {
    this.#importers = new Map(importers.map((importer) => [importer.kind, importer]))
  }

  kinds() {
    return [...this.#importers.values()].map((importer) => ({
      kind: importer.kind,
      fields: importer.fields,
    }))
  }

  /**
   * The same key and the same bytes are the same job; the same key with other bytes is a
   * conflict, so a retried upload can never start a second import.
   */
  async upload(request: {
    readonly tenantId: string
    readonly actor: string
    readonly kind: string
    readonly jobKey: string
    readonly fileName: string
    readonly format: ImportFormat
    readonly locale: ImportLocale
    readonly bytes: Uint8Array
  }): Promise<Either<ImportFailure, { view: ImportView; created: boolean }>> {
    const importer = this.#importers.get(request.kind)
    if (!importer) return left({ kind: 'not-found', message: 'this module has no such import' })
    if (request.bytes.byteLength > this.settings.maxBytes)
      return left(invalid(`the file is larger than ${this.settings.maxBytes} bytes`))
    const sha256 = createHash('sha256').update(request.bytes).digest('hex')
    const existing = await this.store.findByKey(request.tenantId, request.kind, request.jobKey)
    if (existing) {
      if (existing.sha256 !== sha256)
        return left(conflict('this job key was already used for another file'))
      return right({ view: await this.view(existing), created: false })
    }
    const parsed = this.files.read(request.format, request.bytes)
    if (parsed.isLeft()) return left(invalid(parsed.value))
    const { columns, rows, delimiter } = parsed.value
    if (rows.length === 0) return left(invalid('the file has no rows under its header'))
    if (rows.length > this.settings.maxRows)
      return left(invalid(`the file has more than ${this.settings.maxRows} rows`))
    const now = this.clock.now()
    const job: ImportJob = {
      id: randomUUID(),
      tenantId: request.tenantId,
      kind: request.kind,
      jobKey: request.jobKey,
      status: 'uploaded',
      fileName: request.fileName,
      format: request.format,
      locale: request.locale,
      delimiter,
      sha256,
      columns,
      mapping: suggestMapping(importer.fields, columns),
      validatedAt: null,
      requestedBy: request.actor,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      failuresUntil: null,
      purgedAt: null,
    }
    await this.store.create(job, rows)
    return right({ view: await this.view(job), created: true })
  }

  async get(tenantId: string, jobId: string): Promise<Either<ImportFailure, ImportView>> {
    const job = await this.store.find(tenantId, jobId)
    return job ? right(await this.view(job)) : left(notFound)
  }

  async list(tenantId: string, kind?: string): Promise<readonly ImportView[]> {
    const jobs = await this.store.list(tenantId, { kind, limit: LIST_LIMIT })
    return Promise.all(jobs.map((job) => this.view(job)))
  }

  /** Maps the columns and validates every row with the module's own rules. */
  async map(
    tenantId: string,
    jobId: string,
    mapping: ImportMapping,
  ): Promise<Either<ImportFailure, ImportView>> {
    const job = await this.store.find(tenantId, jobId)
    if (!job) return left(notFound)
    const importer = this.#importers.get(job.kind)
    if (!importer) return left(notFound)
    if (!canMap(job.status)) return left(conflict(`a ${job.status} import cannot be remapped`))
    const checked = checkMapping(importer.fields, job.columns, mapping)
    if (checked.isLeft()) return left(invalid(checked.value))
    const rows = await this.store.rows(tenantId, jobId, {})
    const session = await importer.session(actorOf(job))
    const firstLine = new Map<string, number>()
    const verdicts: RowVerdict[] = rows.map((row) => {
      const outcome = session.validate(recordOf(job.columns, checked.value, row.cells))
      if (outcome.isLeft()) return { line: row.line, state: 'invalid', issues: outcome.value }
      const key = session.uniqueKey(outcome.value)
      const first = key === null ? undefined : firstLine.get(key)
      if (first !== undefined)
        return {
          line: row.line,
          state: 'invalid',
          issues: [issue(null, `repeats line ${first} of this file`)],
        }
      if (key !== null) firstLine.set(key, row.line)
      return { line: row.line, state: 'valid', issues: [] }
    })
    const now = this.clock.now()
    if (!(await this.store.validated(tenantId, jobId, checked.value, verdicts, now)))
      return left(conflict('the import changed state; reload it'))
    return this.get(tenantId, jobId)
  }

  /** The counts, the first errors and the first valid rows; confirming requires it. */
  async preview(tenantId: string, jobId: string): Promise<Either<ImportFailure, ImportPreview>> {
    const job = await this.store.find(tenantId, jobId)
    if (!job) return left(notFound)
    if (!canPreview(job.status)) return left(conflict(`a ${job.status} import has no preview`))
    const now = this.clock.now()
    if (job.status === 'validated')
      await this.store.transition(tenantId, jobId, ['validated'], 'previewed', now)
    const [errors, valid] = await Promise.all([
      this.store.rows(tenantId, jobId, { states: ['invalid'], limit: PREVIEW_ERRORS }),
      this.store.rows(tenantId, jobId, { states: ['valid'], limit: PREVIEW_ROWS }),
    ])
    const refreshed = await this.get(tenantId, jobId)
    if (refreshed.isLeft()) return left(refreshed.value)
    return right({
      view: refreshed.value,
      errors: errors.map((row) => ({ line: row.line, reasons: row.issues })),
      sample: valid.map((row) => ({
        line: row.line,
        values: recordOf(job.columns, job.mapping ?? {}, row.cells),
      })),
    })
  }

  async confirm(tenantId: string, jobId: string): Promise<Either<ImportFailure, ImportView>> {
    const job = await this.store.find(tenantId, jobId)
    if (!job) return left(notFound)
    if (!canConfirm(job.status))
      return left(conflict(`preview the import before confirming it (it is ${job.status})`))
    const now = this.clock.now()
    if (!(await this.store.transition(tenantId, jobId, ['previewed'], 'running', now)))
      return left(conflict('the import changed state; reload it'))
    return this.get(tenantId, jobId)
  }

  async cancel(tenantId: string, jobId: string): Promise<Either<ImportFailure, ImportView>> {
    const job = await this.store.find(tenantId, jobId)
    if (!job) return left(notFound)
    if (!canCancel(job.status)) return left(conflict(`a ${job.status} import cannot be cancelled`))
    const now = this.clock.now()
    if (!(await this.store.cancel(tenantId, jobId, now, this.until(now))))
      return left(conflict('the import has already ended'))
    return this.get(tenantId, jobId)
  }

  /** Every refused row, with its line and reasons, in the file's own format. */
  async failures(tenantId: string, jobId: string): Promise<Either<ImportFailure, FailuresFile>> {
    const job = await this.store.find(tenantId, jobId)
    if (!job) return left(notFound)
    const rows = await this.store.rows(tenantId, jobId, { states: ['invalid', 'rejected'] })
    if (job.purgedAt && rows.length > 0)
      return left({ kind: 'gone', message: 'the failed rows were already removed' })
    return right(this.files.failures(job, rows))
  }

  /** One worker pass over one tenant: write, finish, then forget what retention allows. */
  async runTenant(tenantId: string): Promise<TenantImportWork> {
    let written = 0
    let rejected = 0
    let finished = 0
    for (;;) {
      const now = this.clock.now()
      const job = await this.store.claim(tenantId, now, this.leaseFrom(now))
      if (!job) break
      const outcome = await this.process(job)
      written += outcome.written
      rejected += outcome.rejected
      if (outcome.finished) finished += 1
      else break
    }
    const now = this.clock.now()
    const purged = await this.store.purgeExpired(tenantId, now)
    const abandoned = await this.store.abandonStale(
      tenantId,
      new Date(now.getTime() - this.settings.retentionMs),
      now,
      this.until(now),
    )
    return { written, rejected, finished, purged, abandoned }
  }

  private async process(
    job: ImportJob,
  ): Promise<{ written: number; rejected: number; finished: boolean }> {
    const batches = await this.writeBatches(job)
    if (!batches.running) return { ...batches, finished: false }
    const counts = await this.store.counts(job.tenantId, job.id)
    const status = finishedState(counts)
    if (status === null) return { ...batches, finished: false }
    const now = this.clock.now()
    const failed = counts.invalid + counts.rejected > 0
    await this.store.finish(job.tenantId, job.id, status, now, failed ? this.until(now) : null)
    return { ...batches, finished: true }
  }

  /** Writes batches until no valid row is left, or until the job stops running. */
  private async writeBatches(
    job: ImportJob,
  ): Promise<{ written: number; rejected: number; running: boolean }> {
    const importer = this.#importers.get(job.kind)
    if (!importer) throw new Error(`No importer for ${job.kind}`)
    const context = actorOf(job)
    let written = 0
    let rejected = 0
    for (;;) {
      const batch = await this.store.rows(job.tenantId, job.id, {
        states: ['valid'],
        limit: this.settings.batchSize,
      })
      if (batch.length === 0) return { written, rejected, running: true }
      const session = await importer.session(context)
      for (const row of batch) {
        const outcome = await this.write(job, importer, session, row, context)
        if (outcome === 'written') written += 1
        if (outcome === 'rejected') rejected += 1
      }
      if (!(await this.store.renew(job.tenantId, job.id, this.leaseFrom(this.clock.now()))))
        return { written, rejected, running: false }
    }
  }

  private async write(
    job: ImportJob,
    importer: RowImporter,
    session: Awaited<ReturnType<RowImporter['session']>>,
    row: StoredRow,
    context: ImportActor,
  ): Promise<'written' | 'rejected' | 'skipped'> {
    const command = session.validate(recordOf(job.columns, job.mapping ?? {}, row.cells))
    if (command.isLeft()) {
      await this.store.markRejected(job.tenantId, job.id, row.line, command.value)
      return 'rejected'
    }
    try {
      const outcome = await importer.write(
        command.value,
        { jobId: job.id, line: row.line },
        context,
      )
      if (outcome.isLeft()) {
        await this.store.markRejected(job.tenantId, job.id, row.line, outcome.value)
        return 'rejected'
      }
      await this.store.markWritten(job.tenantId, job.id, row.line, outcome.value)
      return 'written'
    } catch (error) {
      if (error instanceof ImportRowTakenError) return 'skipped'
      throw error
    }
  }

  private async view(job: ImportJob): Promise<ImportView> {
    const counts = await this.store.counts(job.tenantId, job.id)
    return { job, progress: progressOf(counts, job.validatedAt !== null) }
  }

  private leaseFrom(now: Date): Date {
    return new Date(now.getTime() + this.settings.leaseMs)
  }

  private until(now: Date): Date {
    return new Date(now.getTime() + this.settings.retentionMs)
  }
}

function actorOf(job: ImportJob): ImportActor {
  return {
    tenantId: job.tenantId,
    actor: job.requestedBy,
    requestId: null,
    numbers: job.format === 'xlsx' ? 'en' : job.locale,
    dates: job.locale,
  }
}
