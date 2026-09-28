import { cursorPayloadSchema } from '@horizon/contracts'
import { z } from 'zod'

/**
 * The cursor is opaque to clients but not unvalidated here: it is decoded and checked
 * before it reaches a query, so a hand-edited cursor is a 422 rather than a strange
 * result set or a driver error.
 */
const cursor = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const bytes = Buffer.from(value, 'base64url')
      return (
        bytes.toString('base64url') === value &&
        cursorPayloadSchema.safeParse(JSON.parse(bytes.toString('utf8'))).success
      )
    } catch {
      return false
    }
  }, 'cursor is invalid')

export const listQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: cursor.optional(),
})

/** The items list also narrows by a term in the SKU or name (Phase 66). */
export const itemListQuerySchema = listQuerySchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
})

export function itemListRequest(query: unknown, tenantId: string) {
  const { search, ...page } = itemListQuerySchema.parse(query)
  return {
    ...listRequest(page, tenantId),
    ...(search === undefined ? {} : { search }),
  }
}

export function listRequest(query: unknown, tenantId: string) {
  const input = listQuerySchema.parse(query)
  return {
    tenantId,
    limit: input.limit,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  }
}
