/**
 * The bulk import job contract (ADR 0059), as this module keeps it.
 *
 * Every module that imports holds its own copy of this file: modules share no code, only
 * the published contract, and the shared e2e checklist keeps the copies behaving alike.
 */

export const IMPORT_STATES = [
  'uploaded',
  'validated',
  'previewed',
  'running',
  'completed',
  'completed-with-failures',
  'cancelled',
] as const
export type ImportState = (typeof IMPORT_STATES)[number]

export type ImportFormat = 'csv' | 'xlsx'
export type ImportLocale = 'pt-BR' | 'en'

/**
 * Where one row is. `pending` until a mapping validates it; `valid` until it is written,
 * refused when written (`rejected`) or left by a cancellation.
 */
export const ROW_STATES = [
  'pending',
  'valid',
  'invalid',
  'written',
  'rejected',
  'cancelled',
] as const
export type RowState = (typeof ROW_STATES)[number]
export type RowCounts = Readonly<Record<RowState, number>>

export interface RowIssue {
  readonly field: string | null
  readonly message: string
}

export type ImportMapping = Readonly<Record<string, string | null>>

export interface ImportJob {
  readonly id: string
  readonly tenantId: string
  readonly kind: string
  readonly jobKey: string
  readonly status: ImportState
  readonly fileName: string
  readonly format: ImportFormat
  readonly locale: ImportLocale
  /** The CSV separator the file used, so the failures file uses it too. */
  readonly delimiter: string
  readonly sha256: string
  readonly columns: readonly string[]
  readonly mapping: ImportMapping | null
  /** When a mapping last validated every row; until then no row is known to be valid. */
  readonly validatedAt: Date | null
  readonly requestedBy: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly finishedAt: Date | null
  readonly failuresUntil: Date | null
  readonly purgedAt: Date | null
}

export interface ImportProgress {
  readonly total: number
  readonly valid: number
  readonly written: number
  readonly failed: number
  readonly remaining: number
  readonly cancelled: number
}

export const EMPTY_COUNTS: RowCounts = {
  pending: 0,
  valid: 0,
  invalid: 0,
  written: 0,
  rejected: 0,
  cancelled: 0,
}

/**
 * Every row is in exactly one of the four buckets, so the total always adds up. `valid`
 * means something only once a mapping has validated the rows.
 */
export function progressOf(counts: RowCounts, validated: boolean): ImportProgress {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  return {
    total,
    valid: validated ? total - counts.invalid : 0,
    written: counts.written,
    failed: counts.invalid + counts.rejected,
    remaining: counts.pending + counts.valid,
    cancelled: counts.cancelled,
  }
}

const MAPPABLE: readonly ImportState[] = ['uploaded', 'validated', 'previewed']
const CANCELLABLE: readonly ImportState[] = ['uploaded', 'validated', 'previewed', 'running']

export const canMap = (status: ImportState) => MAPPABLE.includes(status)
export const canPreview = (status: ImportState) => status === 'validated' || status === 'previewed'
export const canConfirm = (status: ImportState) => status === 'previewed'
export const canCancel = (status: ImportState) => CANCELLABLE.includes(status)
export const isFinished = (status: ImportState) =>
  status === 'completed' || status === 'completed-with-failures' || status === 'cancelled'

/**
 * A running job ends only once no row remains. It is `completed` only if every row was
 * written: one refused row makes it `completed-with-failures`.
 */
export function finishedState(counts: RowCounts): ImportState | null {
  if (counts.pending + counts.valid > 0) return null
  return counts.invalid + counts.rejected + counts.cancelled === 0
    ? 'completed'
    : 'completed-with-failures'
}
