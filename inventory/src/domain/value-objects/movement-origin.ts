/**
 * Why stock moved, and which document says so.
 *
 * A receipt and a shipment need neither: the goods arrived because they were bought and
 * left because they were sold, and the order is already the explanation. Everything in
 * this file is about the movements that have no order behind them — the ones a warehouse
 * decides on by itself — because those are exactly the ones nobody can account for later
 * unless somebody wrote down why.
 */

export const ADJUSTMENT_REASONS = [
  'breakage',
  'loss',
  'theft',
  'expiry',
  'found',
  'correction',
] as const
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number]

export const MOVEMENT_REASONS = ['transfer', 'count', ...ADJUSTMENT_REASONS] as const
export type MovementReason = (typeof MOVEMENT_REASONS)[number]

export const DOCUMENT_TYPES = ['transfer', 'adjustment', 'count'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

/** The document a movement belongs to; the two halves of a transfer share one. */
export interface MovementDocument {
  readonly type: DocumentType
  readonly id: string
}

export interface MovementOrigin {
  readonly reason: MovementReason
  readonly document: MovementDocument
}

/**
 * Stock is not found by taking it off the shelf, and breakage does not put any back.
 *
 * `correction` is the only reason that works in both directions, because it is the one
 * that admits the figure was simply wrong rather than claiming to know what happened.
 */
const ADDING = new Set<AdjustmentReason>(['found', 'correction'])
const REMOVING = new Set<AdjustmentReason>(['breakage', 'loss', 'theft', 'expiry', 'correction'])

export function reasonAdmits(reason: AdjustmentReason, direction: 'in' | 'out'): boolean {
  return direction === 'in' ? ADDING.has(reason) : REMOVING.has(reason)
}

export function isAdjustmentReason(value: string): value is AdjustmentReason {
  return (ADJUSTMENT_REASONS as readonly string[]).includes(value)
}
