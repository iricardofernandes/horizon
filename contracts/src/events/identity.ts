import { z } from 'zod'

import { instantSchema, uuidSchema } from '../common'
import { defineEvent } from './define'

/**
 * Events published by `identity/`.
 *
 * Phase 3 defined one, deliberately — enough to prove the envelope, the registry, the
 * generated catalogue and the compatibility gate all work end to end. The remaining five
 * arrive here in phase 4, with the aggregates that publish them, because a schema written
 * before the aggregate it describes is a guess.
 *
 * Note what the payloads do **not** carry. No email address, no personal name, no role
 * expansion. An event is durable, is fanned out to consumers written later, and is
 * replayable from the outbox — so personal data inside one is personal data that erasure
 * cannot reach (ADR 0026). Consumers that need a name ask identity for it under the
 * subject's own key; consumers that need a permission expand the role themselves
 * (ADR 0023).
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

export const userRegistered = defineEvent({
  type: 'identity.user.registered',
  version: 1,
  description:
    'A user was created within a tenant. Consumers may create per-user defaults; none ' +
    'may assume the user can do anything yet, because roles are assigned separately.',
  payload: z.object({
    tenantId: uuidSchema,
    userId: uuidSchema,
    /** Deliberately no email and no name — see the note at the top of this file. */
    registeredAt: instantSchema,
  }),
})

export const userDisabled = defineEvent({
  type: 'identity.user.disabled',
  version: 1,
  description:
    'Access was revoked. Every consumer holding cached authorization state for this ' +
    'user must drop it; sessions and API keys issued by the user are already dead at ' +
    'the source.',
  payload: z.object({
    tenantId: uuidSchema,
    userId: uuidSchema,
    disabledAt: instantSchema,
  }),
})

export const apiKeyRevoked = defineEvent({
  type: 'identity.api-key.revoked',
  version: 1,
  description:
    'An API key is no longer valid. Carries the public prefix rather than the key, so a ' +
    'consumer can invalidate a cache entry and an operator can match a log line, and ' +
    'neither ever handles the secret.',
  payload: z.object({
    tenantId: uuidSchema,
    apiKeyId: uuidSchema,
    /** The plaintext, indexed prefix. Identifying, never usable (ADR 0022). */
    prefix: z.string().length(24),
    revokedAt: instantSchema,
  }),
})

export const sessionReuseDetected = defineEvent({
  type: 'identity.session.reuse-detected',
  version: 1,
  description:
    'A rotated refresh token was replayed, which means two parties hold tokens from one ' +
    'family. The family was destroyed, logging out both. Security-relevant: consumers ' +
    'that alert on anything should alert on this.',
  payload: z.object({
    tenantId: uuidSchema,
    userId: uuidSchema,
    /** The session family, not the token. Tokens never leave identity in any form. */
    familyId: uuidSchema,
    detectedAt: instantSchema,
  }),
})

export const dataSubjectErased = defineEvent({
  type: 'identity.data-subject.erased',
  version: 1,
  description:
    'A data-subject key was destroyed (ADR 0026). Every module holding personal data ' +
    'for this subject must shred its own copies; the ciphertext identity holds is now ' +
    'unrecoverable by anyone, including the operator.',
  payload: z.object({
    tenantId: uuidSchema,
    /** The subject, which is the user id. Not personal data by itself. */
    subjectId: uuidSchema,
    erasedAt: instantSchema,
  }),
})
