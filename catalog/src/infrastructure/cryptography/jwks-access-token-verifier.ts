import { createRemoteJWKSet, errors, jwtVerify } from 'jose'
import { z } from 'zod'
import { type Either, left, right } from '@/core/either'
import { InvalidAccessTokenError } from '@/core/errors/errors/invalid-access-token-error'

export interface VerifiedAccessToken {
  readonly subject: string
  readonly tenantId: string
  readonly roles: readonly { module: string; role: string }[]
  readonly jti: string
  readonly expiresAt: Date
}

/** The key set could not be consulted at all — an outage, not a rejected token. */
export class AccessTokenVerificationUnavailableError extends Error {
  constructor() {
    super('the signing key set could not be retrieved')
  }
}

export interface JwksAccessTokenVerifierOptions {
  readonly jwksUrl: string
  readonly maxTokenAgeSeconds: number
  readonly timeoutMs?: number
  readonly cooldownMs?: number
  readonly cacheMaxAgeMs?: number
}

const CLAIMS = z.object({
  sub: z.string().min(1),
  tenant_id: z.uuid(),
  roles: z.array(z.object({ module: z.string().min(1), role: z.string().min(1) })).max(50),
  jti: z.string().min(1),
  iss: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
})

/**
 * Catalog re-verifies every bearer token itself against Identity's published keys
 * (ADR 0008): reaching this service's port directly grants nothing, and Kong is
 * defence in depth rather than the only check.
 *
 * `alg` is pinned to EdDSA (ADR 0018) — a verifier that trusts the token's own header
 * accepts `none`. The issuer is `horizon-identity-<kid>`, one issuer per signing key,
 * because Kong OSS selects a configured credential by `iss` (ADR 0036); binding the
 * claim to the header's `kid` is what stops a token signed by a retired key from being
 * replayed under the active key's issuer.
 */
export class JwksAccessTokenVerifier {
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>
  readonly #maxTokenAgeSeconds: number

  constructor(options: JwksAccessTokenVerifierOptions) {
    if (!Number.isSafeInteger(options.maxTokenAgeSeconds) || options.maxTokenAgeSeconds <= 0)
      throw new Error('Access token max age must be a positive safe integer')
    this.#maxTokenAgeSeconds = options.maxTokenAgeSeconds
    this.#jwks = createRemoteJWKSet(new URL(options.jwksUrl), {
      timeoutDuration: options.timeoutMs ?? 5000,
      cooldownDuration: options.cooldownMs ?? 30_000,
      // Rotation is an overlap window (ADR 0018): a cached set is refreshed when an
      // unknown kid arrives, subject to the cooldown, so a new key is picked up without
      // fetching the document on every request.
      cacheMaxAge: options.cacheMaxAgeMs ?? 600_000,
    })
  }

  async verify(token: string): Promise<Either<InvalidAccessTokenError, VerifiedAccessToken>> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.#jwks, {
        algorithms: ['EdDSA'],
        typ: 'JWT',
        maxTokenAge: this.#maxTokenAgeSeconds,
        requiredClaims: ['sub', 'tenant_id', 'roles', 'jti', 'iss', 'iat', 'exp'],
      })
      const claims = CLAIMS.parse(payload)
      if (claims.iss !== `horizon-identity-${protectedHeader.kid ?? ''}`)
        return left(new InvalidAccessTokenError())
      if (claims.exp <= claims.iat || claims.exp - claims.iat > this.#maxTokenAgeSeconds)
        return left(new InvalidAccessTokenError())

      return right({
        subject: claims.sub,
        tenantId: claims.tenant_id,
        roles: claims.roles,
        jti: claims.jti,
        expiresAt: new Date(claims.exp * 1000),
      })
    } catch (error) {
      if (unreachable(error)) throw new AccessTokenVerificationUnavailableError()
      return left(new InvalidAccessTokenError())
    }
  }
}

/**
 * An unknown `kid` is a rejected token; a key set that never arrived is an outage. The
 * two must not share a status code, or a JWKS incident reads as every token being
 * forged.
 */
function unreachable(error: unknown): boolean {
  if (error instanceof errors.JWKSTimeout) return true
  if (error instanceof errors.JOSEError) return false
  if (error instanceof z.ZodError) return false
  return error instanceof TypeError || error instanceof AggregateError
}
