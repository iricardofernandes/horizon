import { JOURNALED_SOURCES, type Source } from './journal'

/**
 * Seals and watermarks (ADR 0058).
 *
 * A producer's seal says how many of a tenant's events occurred up to `through`. When the
 * journal holds exactly that many, nothing before `through` is missing and the source's
 * watermark moves there. An arrival proves only itself, so nothing else moves it.
 */

/** No transaction open at the producer can still add a row this far back. */
export const SEAL_MARGIN_MS = 120_000

export type SealOutcome = 'matched' | 'mismatched' | 'refused'

export interface SealFacts {
  readonly through: Date
  readonly receivedAt: Date
  readonly producerCount: number
  readonly journalCount: number
}

/** A seal inside the margin could be outrun by a late row, so it proves nothing. */
export function sealOutcome(seal: SealFacts): SealOutcome {
  if (seal.through.getTime() > seal.receivedAt.getTime() - SEAL_MARGIN_MS) return 'refused'
  return seal.producerCount === seal.journalCount ? 'matched' : 'mismatched'
}

/** A matched seal never moves a watermark back. */
export function advancedWatermark(current: Date | null, through: Date): Date {
  return current && current.getTime() >= through.getTime() ? current : through
}

export function isSettled(watermark: Date | null, cutoff: Date): boolean {
  return watermark !== null && watermark.getTime() >= cutoff.getTime()
}

export interface Settlement {
  readonly settled: boolean
  readonly unsettled: readonly Source[]
}

/** A cutoff is settled for a set of sources when every one is proven complete through it. */
export function settlementOf(
  watermarks: ReadonlyMap<Source, Date | null>,
  cutoff: Date,
  sources: readonly Source[] = JOURNALED_SOURCES,
): Settlement {
  const unsettled = sources.filter((source) => !isSettled(watermarks.get(source) ?? null, cutoff))
  return { settled: unsettled.length === 0, unsettled }
}
