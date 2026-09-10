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
export function boundedLimit(requested?: number): number {
  if (requested === undefined) return DEFAULT_PAGE_SIZE
  if (requested < 1) return 1
  return Math.min(Math.trunc(requested), MAX_PAGE_SIZE)
}
