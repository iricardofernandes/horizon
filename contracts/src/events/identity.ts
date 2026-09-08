import { z } from 'zod'

import { instantSchema, uuidSchema } from '../common'
import { defineEvent } from './define'

/**
 * Events published by `identity/`.
 *
 * Phase 3 defines one, deliberately: enough to prove the envelope, the registry, the
 * generated catalogue and the compatibility gate all work end to end. The rest arrive
 * with the modules that publish them, because a schema written before the aggregate it
 * describes is a guess.
 */

export const tenantCreated = defineEvent({
  type: 'identity.tenant.created',
  version: 1,
  description:
    'A tenant now exists. Consumers may create tenant-scoped defaults — catalog creates ' +
    'the default unit-of-measure set and an empty base price list.',
  payload: z.object({
    tenantId: uuidSchema,
    /** Display name. Not unique, and not an identifier. */
    name: z.string().min(1).max(200),
    /**
     * IANA zone, applied at presentation only. Storage and comparison are always UTC
     * (ADR 0011).
     */
    timezone: z.string().min(1).describe('IANA timezone, e.g. America/Sao_Paulo'),
    createdAt: instantSchema,
  }),
})
