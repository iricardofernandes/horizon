import type { Either } from '@/core/either'
import type {
  ImportFormat,
  ImportJob,
  ImportLocale,
  ImportMapping,
  ImportState,
  RowCounts,
  RowIssue,
  RowState,
} from '@/domain/imports/import-job'
import type { ImportFieldSpec, ImportRecord } from '@/domain/imports/import-values'

export interface SourceRow {
  /** The row's line in the file; the header is line 1. */
  readonly line: number
  readonly cells: readonly string[]
}

export interface StoredRow extends SourceRow {
  readonly state: RowState
  readonly issues: readonly RowIssue[]
  readonly reference: string | null
}

export interface ParsedFile {
  readonly columns: readonly string[]
  readonly rows: readonly SourceRow[]
  readonly delimiter: string
}

export interface FailuresFile {
  readonly fileName: string
  readonly contentType: string
  readonly bytes: Uint8Array
}

/** Reading an uploaded file, and writing its failures back in the same format. */
export abstract class ImportFiles {
  abstract read(format: ImportFormat, bytes: Uint8Array): Either<string, ParsedFile>
  abstract failures(job: ImportJob, rows: readonly StoredRow[]): FailuresFile
}

export interface RowVerdict {
  readonly line: number
  readonly state: 'valid' | 'invalid'
  readonly issues: readonly RowIssue[]
}

/** Every method runs in the job's tenant; nothing here crosses tenants. */
export abstract class ImportStore {
  abstract create(job: ImportJob, rows: readonly SourceRow[]): Promise<void>
  abstract findByKey(tenantId: string, kind: string, jobKey: string): Promise<ImportJob | null>
  abstract find(tenantId: string, jobId: string): Promise<ImportJob | null>
  abstract list(
    tenantId: string,
    filter: { readonly kind?: string | undefined; readonly limit: number },
  ): Promise<readonly ImportJob[]>
  abstract counts(tenantId: string, jobId: string): Promise<RowCounts>
  abstract rows(
    tenantId: string,
    jobId: string,
    filter: { readonly states?: readonly RowState[]; readonly limit?: number },
  ): Promise<readonly StoredRow[]>
  /** Records a mapping and every row's verdict, if the job may still be mapped. */
  abstract validated(
    tenantId: string,
    jobId: string,
    mapping: ImportMapping,
    verdicts: readonly RowVerdict[],
    now: Date,
  ): Promise<boolean>
  abstract transition(
    tenantId: string,
    jobId: string,
    from: readonly ImportState[],
    to: ImportState,
    now: Date,
  ): Promise<boolean>
  /**
   * Cancels the job and every row not yet written, in one transaction; written rows lose
   * their values. False when the job had already ended.
   */
  abstract cancel(tenantId: string, jobId: string, now: Date, failuresUntil: Date): Promise<boolean>
  /** Takes one running job whose lease has lapsed, and holds it until `leaseUntil`. */
  abstract claim(tenantId: string, now: Date, leaseUntil: Date): Promise<ImportJob | null>
  /** Extends the lease; false once the job is no longer running. */
  abstract renew(tenantId: string, jobId: string, leaseUntil: Date): Promise<boolean>
  abstract markWritten(
    tenantId: string,
    jobId: string,
    line: number,
    reference: string,
  ): Promise<void>
  abstract markRejected(
    tenantId: string,
    jobId: string,
    line: number,
    issues: readonly RowIssue[],
  ): Promise<void>
  /** Ends a running job; written rows lose their values. */
  abstract finish(
    tenantId: string,
    jobId: string,
    status: ImportState,
    now: Date,
    failuresUntil: Date | null,
  ): Promise<void>
  /** Clears the values of jobs whose failures are past retention; returns how many. */
  abstract purgeExpired(tenantId: string, now: Date): Promise<number>
  /** Unconfirmed jobs untouched since `before` are cancelled; returns how many. */
  abstract abandonStale(
    tenantId: string,
    before: Date,
    now: Date,
    failuresUntil: Date,
  ): Promise<number>
}

/** Who a row is written for: the person who uploaded the file. */
export interface ImportActor {
  readonly tenantId: string
  readonly actor: string
  readonly requestId: string | null
  /** How the file writes numbers: an XLSX is always read as English. */
  readonly numbers: ImportLocale
  /** How the file writes dates. */
  readonly dates: ImportLocale
}

/** A row's key: a write keyed by it happens at most once. */
export interface RowKey {
  readonly jobId: string
  readonly line: number
}

export interface ImportSession<C> {
  validate(record: ImportRecord): Either<readonly RowIssue[], C>
  /** What must be unique within one file (a document, a code), or null. */
  uniqueKey(command: C): string | null
}

/**
 * One kind of import in this module. Validation uses the module's value objects and the
 * lookups it can answer; writing goes through the module's own use case, keyed by the row.
 */
export abstract class RowImporter<C = unknown> {
  abstract readonly kind: string
  abstract readonly fields: readonly ImportFieldSpec[]
  abstract session(context: ImportActor): Promise<ImportSession<C>>
  /** The identifier written, or why the use case refused the row. */
  abstract write(
    command: C,
    key: RowKey,
    context: ImportActor,
  ): Promise<Either<readonly RowIssue[], string>>
}

/** The row was taken by a cancellation or another worker; its write was rolled back. */
export class ImportRowTakenError extends Error {
  constructor() {
    super('The import row is no longer waiting to be written')
    this.name = 'ImportRowTakenError'
  }
}
