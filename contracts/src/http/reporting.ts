import { z } from 'zod'

import { instantSchema, tenantIdSchema, uuidSchema } from '../common'

/**
 * The queue a producer's `republish:journal` sends to through the default exchange
 * (ADR 0058). A replay never goes through `horizon.events`, so no other consumer sees an
 * old event again.
 */
export const REPORTING_REPLAY_QUEUE = 'reporting.replay'

/**
 * A producer's proof of how much of a tenant's history it has: the number of its outbox
 * rows for the tenant that occurred at or before `through` (ADR 0058). Reporting moves
 * the source's watermark to `through` only when its journal holds the same count.
 */
export const journalSealSchema = z
  .object({
    kind: z.literal('seal'),
    sealId: uuidSchema,
    source: z.string().regex(/^[a-z][a-z0-9-]*$/),
    tenantId: tenantIdSchema,
    through: instantSchema,
    count: z.number().int().nonnegative(),
    sealedAt: instantSchema,
  })
  .strict()

export type JournalSeal = z.infer<typeof journalSealSchema>
