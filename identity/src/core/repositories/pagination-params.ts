/**
 * Keyset pagination, and an explicit bounded limit.
 *
 * The reference project's `PaginationParams` was `{ page: number }` with the page size
 * hard-coded — in two places, which disagreed (`docs/reference-analysis.md` §2.5). Here
 * the limit is a parameter with a maximum, and the cursor is opaque so its encoding stays
 * free to change.
 */
export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 100

export interface PaginationParams {
  readonly limit: number
  readonly cursor?: string
}

export interface Page<T> {
  readonly items: readonly T[]
  readonly nextCursor?: string
  readonly hasMore: boolean
}

/** Clamp a requested size into the allowed range. A client cannot ask for everything. */
export function boundedLimit(requested?: number): number {
  if (requested === undefined) return DEFAULT_PAGE_SIZE
  if (requested < 1) return 1
  return Math.min(Math.trunc(requested), MAX_PAGE_SIZE)
}
