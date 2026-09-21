import { z } from 'zod'

import { uuidSchema } from '../common'
import { defineEvent } from './define'

export const PARTY_ROLES = ['customer', 'supplier', 'carrier', 'prospect', 'partner'] as const
const partyRoleSchema = z.enum(PARTY_ROLES)

const partyId = uuidSchema.describe('Party identifier, shared by every context that projects it')
const roles = z.array(partyRoleSchema).max(PARTY_ROLES.length)
/**
 * The email pattern as published in 0.4.0, pinned here byte for byte. `z.email()` emits
 * whatever regex the installed zod ships, so a routine zod upgrade would otherwise rewrite
 * a published schema in place without a version change (ADR 0030).
 *
 * It is assembled from parts on purpose: the bundler folds a constant regex into a literal
 * and drops escapes it considers redundant, which keeps the meaning but changes the
 * published text the compatibility gate compares.
 */
const PUBLISHED_EMAIL_PATTERN = new RegExp(
  [
    '^(?!\\.)(?!.*\\.\\.)',
    "([A-Za-z0-9_'+\\-\\.]*)",
    '[A-Za-z0-9_+-]@',
    '([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+',
    '[A-Za-z]{2,}$',
  ].join(''),
)

const identity = {
  legalName: z.string().min(2).max(160),
  tradeName: z.string().min(2).max(160).nullable(),
  email: z.email({ pattern: PUBLISHED_EMAIL_PATTERN }).max(254),
  phone: z.string().regex(/^\+?\d{8,15}$/),
  address: z.string().min(5).max(500),
}

export const partyRegistered = defineEvent({
  type: 'parties.party.registered',
  version: 1,
  description:
    'An organization or person entered the shared registry with the roles it plays. Consumers build their own projection keyed by the party id; the tax identifier is deliberately absent.',
  payload: z.object({
    partyId,
    kind: z.enum(['organization', 'person']),
    ...identity,
    roles,
  }),
})

export const partyUpdated = defineEvent({
  type: 'parties.party.updated',
  version: 1,
  description:
    'A party’s identifying details, roles or active state changed. Consumers replace their projected copy; posted documents keep the snapshot they took.',
  payload: z.object({ partyId, ...identity, roles, active: z.boolean() }),
})

export const partyRoleGranted = defineEvent({
  type: 'parties.party.role-granted',
  version: 1,
  description:
    'A party started playing a role — a supplier became a customer too. `roles` is the complete set after the change; a `parties.party.updated` carrying the party’s details follows in the same transaction.',
  payload: z.object({ partyId, role: partyRoleSchema, roles }),
})

export const partyRoleRevoked = defineEvent({
  type: 'parties.party.role-revoked',
  version: 1,
  description:
    'A party stopped playing a role. The party remains, and documents that already reference it keep that reference.',
  payload: z.object({ partyId, role: partyRoleSchema, roles }),
})

export const partyErased = defineEvent({
  type: 'parties.party.erased',
  version: 1,
  description:
    'The party’s personal data was crypto-shredded. Every projection must destroy its own copy; the payload carries no personal data by construction.',
  payload: z.object({ partyId }),
})

export const partyFiscalProfileChanged = defineEvent({
  type: 'parties.party.fiscal-profile-changed',
  version: 1,
  description:
    'A restricted Fiscal projector may fetch this exact recipient revision; no personal data is carried on the bus.',
  payload: z.strictObject({
    partyId,
    revision: z.number().int().positive(),
    effectiveFrom: z.iso.date(),
  }),
})
