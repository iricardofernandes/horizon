import { z } from 'zod'

import { instantSchema, uuidSchema } from '../common'

/**
 * Keyset pagination, not offset.
 *
 * Offset pagination degrades as a table grows — the database still walks the skipped
 * rows — and it skips or repeats items when rows are inserted mid-traversal. A keyset
 * cursor is stable under concurrent writes and costs the same at page 1 and page 10,000.
 *
 * The cursor is opaque to clients on purpose: it encodes `(createdAt, id)`, which is
 * indexable because every composite index leads with `tenant_id` (ADR 0017), and making
 * it opaque leaves the encoding free to change.
 */
export const paginationQuerySchema = z.object({
  /** Bounded so a client cannot ask for an unbounded result set. */
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
})

export type PaginationQuery = z.infer<typeof paginationQuerySchema>

export const pageInfoSchema = z.object({
  /** Absent when there are no further pages. Its absence is the end condition. */
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
})

/**
 * The envelope every list endpoint returns.
 *
 * There is deliberately no `total`. Counting rows behind an RLS policy on a large table
 * is expensive, and almost no caller needs an exact total — those that do can ask for it
 * explicitly on an endpoint built for it.
 */
export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    page: pageInfoSchema,
  })
}

/** The decoded form of a cursor. Encoding is base64url of this, and is not a contract. */
export const cursorPayloadSchema = z.object({
  createdAt: instantSchema,
  id: uuidSchema,
})
