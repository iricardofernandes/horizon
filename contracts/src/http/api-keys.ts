import { z } from 'zod'

import { instantSchema, tenantIdSchema, uuidSchema } from '../common'
import { MODULES, type ModuleName } from '../roles'

/**
 * Scopes of an API key (ADR 0022, ADR 0064).
 *
 * A module with roles is reached by `<module>:read` or `<module>:write`. Modules that hold
 * no roles of their own — `agent`, `files`, `knowledge` — have scope-only names: they carry
 * no role into a token, and what they reach is still decided by the owning modules' roles.
 */
export const SCOPE_ONLY_NAMES = [
  'agent:connect',
  'files:read',
  'files:write',
  'knowledge:read',
] as const

/** The services that answer requests without roles of their own, reached by scope only. */
export const SCOPE_ONLY_MODULES = ['agent', 'files', 'knowledge'] as const

export type ScopedModule = ModuleName | (typeof SCOPE_ONLY_MODULES)[number]

export const API_KEY_SCOPES = [
  ...MODULES.flatMap((module) => [`${module}:read`, `${module}:write`] as const),
  ...SCOPE_ONLY_NAMES,
] as const

export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES)
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>

/**
 * The `scp` claim of an access token minted from a key. Absent on a signed-in person's
 * token; present, even empty, means the bearer is a key and every module checks it.
 */
export const accessTokenScopesSchema = z.array(z.string().min(1).max(64)).max(60)

/** `POST /auth/api-key/token`: a key exchanged for a 60-second access token (ADR 0064). */
export const apiKeyTokenResponseSchema = z
  .object({
    tenantId: tenantIdSchema,
    apiKeyId: uuidSchema,
    accessToken: z.string().min(20),
    expiresAt: instantSchema,
    scopes: z.array(apiKeyScopeSchema),
  })
  .strict()

export type ApiKeyTokenResponse = z.infer<typeof apiKeyTokenResponseSchema>

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * May a token with these scopes make this request to this module? (ADR 0064)
 *
 * - No scopes (`undefined`): a signed-in person, decided by roles alone.
 * - A read (`GET`, `HEAD`, `OPTIONS`) needs `<module>:read` or `<module>:write`.
 * - Anything else is a write, and needs `<module>:write` — including a `POST` that only
 *   computes, which is the reading that can never let a write through a read scope.
 *
 * `module` is the service answering the request, never a segment of its path.
 */
export function scopeAllows(
  scopes: readonly string[] | undefined,
  module: ScopedModule,
  method: string,
): boolean {
  if (scopes === undefined) return true
  if (scopes.includes(`${module}:write`)) return true
  return READ_METHODS.has(method.toUpperCase()) && scopes.includes(`${module}:read`)
}

/** The refusal every module answers with, so a read-only key reads the same everywhere. */
export const SCOPE_REFUSAL_MESSAGE = "The API key's scopes do not permit this operation"
