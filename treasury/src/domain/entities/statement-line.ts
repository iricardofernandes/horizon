import { createHash } from 'node:crypto'

/**
 * A line a bank asserted. Immutable: reconciliation state lives beside it, never on it, so
 * the only independent record in the process is never edited to agree with the ERP
 * (ADR 0046).
 */
export interface StatementLine {
  readonly id: string
  readonly tenantId: string
  readonly accountId: string
  readonly importId: string
  readonly fingerprint: string
  readonly postedOn: string
  /** Signed minor units: positive in, negative out. */
  readonly amount: bigint
  readonly currency: string
  readonly bankReference: string | null
  readonly documentId: string | null
  readonly description: string
  readonly counterparty: string | null
  readonly raw: Readonly<Record<string, string>>
}

/** Collapses what banks vary between exports: case, accents, repeated spaces. */
export function normalizedText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * The identity of a line across imports. The bank's own reference wins when it sends one.
 * Otherwise the date, amount and description identify it, with `occurrence` telling apart
 * identical lines within one file — so importing the same file again yields the same
 * fingerprints and stores nothing.
 */
export function statementFingerprint(
  accountId: string,
  line: {
    readonly postedOn: string
    readonly amount: bigint
    readonly bankReference: string | null
    readonly description: string
  },
  occurrence: number,
): string {
  const identity = line.bankReference
    ? ['ref', line.bankReference.trim()]
    : ['line', line.postedOn, line.amount.toString(), normalizedText(line.description), occurrence]
  return createHash('sha256')
    .update(JSON.stringify([accountId, ...identity]))
    .digest('hex')
}

/** Fingerprints for a whole file, numbering identical unreferenced lines in file order. */
export function fingerprintsOf(
  accountId: string,
  lines: readonly Parameters<typeof statementFingerprint>[1][],
): string[] {
  const seen = new Map<string, number>()
  return lines.map((line) => {
    const key = `${line.postedOn}|${line.amount}|${normalizedText(line.description)}`
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)
    return statementFingerprint(accountId, line, occurrence)
  })
}
