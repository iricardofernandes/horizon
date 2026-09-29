/** A document's path through the index (Phase 74). */
export const DOCUMENT_STATES = [
  'pending',
  'indexing',
  'indexed',
  'no-text',
  'failed',
  'deleted',
] as const
export type DocumentState = (typeof DOCUMENT_STATES)[number]

/** Attempts before a document is left `failed` for a person to look at. */
export const MAX_ATTEMPTS = 5

/** 30 s, 1 min, 2 min, 4 min… capped at an hour: a failing file never busies the worker. */
export function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 3_600_000)
}

/** After a failed attempt: try again later, or give up for good. */
export function afterFailure(attempts: number): {
  state: 'pending' | 'failed'
  delayMs: number | null
} {
  return attempts >= MAX_ATTEMPTS
    ? { state: 'failed', delayMs: null }
    : { state: 'pending', delayMs: retryDelayMs(attempts) }
}
