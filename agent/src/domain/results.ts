import { createHash } from 'node:crypto'
import { canonicalJson } from '@/core/audit/canonical-json'

/** What a call came to, as the audit and the metrics name it. */
export type CallOutcome = 'ok' | 'refused' | 'not-found' | 'failed'

export interface CappedResult {
  /** The answer as the agent receives it: JSON text, never longer than the byte cap. */
  readonly text: string
  /** Rows kept, when the answer is a list. */
  readonly rows: number | null
  readonly truncated: boolean
  readonly bytes: number
}

/**
 * The rows of a list answer, wherever the module put them: a bare array, or `data` on an
 * envelope. A single record has none.
 */
function rowsOf(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) return value
  if (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { data?: unknown }).data)
  )
    return (value as { data: unknown[] }).data
  return null
}

function withRows(value: unknown, rows: readonly unknown[]): unknown {
  return Array.isArray(value) ? rows : { ...(value as object), data: rows }
}

/**
 * Cut an answer to what one tool call may return (ADR 0065): at most `maxRows` rows, then at
 * most `maxBytes` of text. A cut answer says so, and keeps the rows it could.
 */
export function capResult(value: unknown, maxRows: number, maxBytes: number): CappedResult {
  const rows = rowsOf(value)
  const rowsCut = rows !== null && rows.length > maxRows
  const kept = rows === null ? value : withRows(value, rows.slice(0, maxRows))
  const envelope = { truncated: rowsCut, result: kept }
  const text = JSON.stringify(envelope)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes)
    return {
      text,
      rows: rows === null ? null : Math.min(rows.length, maxRows),
      truncated: rowsCut,
      bytes,
    }
  const cut = Buffer.from(JSON.stringify({ truncated: true, result: kept }), 'utf8')
    .subarray(0, maxBytes)
    .toString('utf8')
  // A multi-byte character cut in half decodes to U+FFFD; drop it rather than return a stray.
  const clean = cut.endsWith('�') ? cut.slice(0, -1) : cut
  return {
    text: `${clean}\n[truncated: the answer exceeded ${maxBytes} bytes]`,
    rows: rows === null ? null : Math.min(rows.length, maxRows),
    truncated: true,
    bytes: Buffer.byteLength(clean, 'utf8'),
  }
}

/** SHA-256 of the canonical JSON of the arguments: what the audit keeps instead of them. */
export function argumentsDigest(args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex')
}

/** A module's answer status, as an outcome. */
export function outcomeOf(status: number): CallOutcome {
  if (status < 400) return 'ok'
  if (status === 404) return 'not-found'
  if (status < 500) return 'refused'
  return 'failed'
}
