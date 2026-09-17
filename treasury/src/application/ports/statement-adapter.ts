import type { Either } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

export const STATEMENT_FORMATS = ['ofx', 'csv'] as const
export type StatementFormat = (typeof STATEMENT_FORMATS)[number]

/**
 * One statement line as the bank sent it, normalized but not interpreted. The bank's own
 * reference, description and raw fields are kept so nothing it said is lost (ADR 0046).
 */
export interface ParsedStatementLine {
  readonly postedOn: string
  /** Signed minor units: positive money in, negative money out. */
  readonly amount: bigint
  readonly bankReference: string | null
  readonly documentId: string | null
  readonly description: string
  readonly counterparty: string | null
  readonly raw: Readonly<Record<string, string>>
}

export interface ParsedStatement {
  readonly currency: string | null
  readonly accountReference: string | null
  readonly closingBalance: { readonly amount: bigint; readonly on: string } | null
  readonly lines: readonly ParsedStatementLine[]
}

/** A file format. Adding one never touches reconciliation. */
export interface StatementAdapter {
  readonly format: StatementFormat
  parse(content: string): Either<InvalidInputError, ParsedStatement>
}

/**
 * A bank feed or Open Finance provider yields the same normalized statement a file does, so
 * no provider becomes a core-domain dependency. Its credentials are sealed with a secret box
 * before they are stored; none is implemented yet.
 */
export interface BankFeedPort {
  readonly provider: string
  fetch(request: {
    readonly sealedCredentials: string
    readonly accountReference: string
    readonly since: string
  }): Promise<Either<InvalidInputError, ParsedStatement>>
}
