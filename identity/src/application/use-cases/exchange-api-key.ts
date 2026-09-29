import { type Either, left, right } from '@/core/either'
import { NotAllowedError } from '@/core/errors/errors/not-allowed-error'
import {
  ApiKeyRateLimitedError,
  RateLimitUnavailableError,
} from '@/domain/errors/api-key-rate-limited-error'
import type { InvalidCredentialsError } from '@/domain/errors/invalid-credentials-error'
import type { ScopeBeyondIssuerError } from '@/domain/errors/scope-beyond-issuer-error'
import { SCOPE_ONLY_MODULES } from '@/domain/value-objects/api-key-scopes'
import type { RoleAssignment } from '@/domain/value-objects/role-assignments'
import type { AccessTokenSigner } from '../ports/access-token-signer'
import type { ApiKeyRateLimiter } from '../ports/api-key-rate-limiter'
import type { Clock } from '../ports/clock'
import type { AuthenticateApiKeyUseCase, AuthenticatedApiKey } from './authenticate-api-key'

/** A key token lives one minute: revoking the key takes effect on the next exchange. */
export const KEY_TOKEN_TTL_SECONDS = 60

export interface ExchangeApiKeyRequest {
  readonly tenantId: string
  readonly presented: string
}

export interface ExchangedApiKey {
  readonly tenantId: string
  readonly apiKeyId: string
  readonly accessToken: string
  readonly expiresAt: Date
  readonly scopes: readonly string[]
}

export type ExchangeApiKeyResponse = Either<
  | InvalidCredentialsError
  | ScopeBeyondIssuerError
  | ApiKeyRateLimitedError
  | RateLimitUnavailableError
  | NotAllowedError,
  ExchangedApiKey
>

/** What the fiscal worker's key must hold, and the only roles its token carries. */
const FISCAL_SCOPES = ['catalog:read', 'identity:read', 'parties:read'] as const
const FISCAL_ROLES: readonly RoleAssignment[] = [
  { module: 'parties', role: 'fiscal-reader' },
  { module: 'identity', role: 'fiscal-reader' },
  { module: 'catalog', role: 'viewer' },
]

/**
 * A key exchanged for an access token that carries its scopes (ADR 0064).
 *
 * The token's roles are the issuer's **current** roles, only in modules the key has a
 * scope for; scope-only services (`agent`, `files`, `knowledge`) carry none. `scp` lets
 * every module refuse a write the key was not given, and `key_issuer` names the person
 * behind it. Authentication re-evaluates the key against its issuer first, so a key that
 * has outgrown its issuer never gets this far.
 */
export class ExchangeApiKeyUseCase {
  constructor(
    private readonly authenticate: AuthenticateApiKeyUseCase,
    private readonly limiter: ApiKeyRateLimiter,
    private readonly signer: AccessTokenSigner,
    private readonly clock: Clock,
  ) {}

  async forKey(request: ExchangeApiKeyRequest): Promise<ExchangeApiKeyResponse> {
    const key = await this.admit(request)
    if (key.isLeft()) return left(key.value)
    const reached = new Set(key.value.scopes.map((scope) => scope.slice(0, scope.indexOf(':'))))
    const scopeOnly: readonly string[] = SCOPE_ONLY_MODULES
    const roles = key.value.roles.filter(
      (role) => reached.has(role.module) && !scopeOnly.includes(role.module),
    )
    return right(
      await this.mint(request.tenantId, key.value, roles, {
        ttlSeconds: KEY_TOKEN_TTL_SECONDS,
      }),
    )
  }

  /**
   * The fiscal worker's reader token: three fixed roles, and the lifetime of an ordinary
   * access token, which its cache relies on. Its key must hold exactly what it reads.
   */
  async forFiscalReader(request: ExchangeApiKeyRequest): Promise<ExchangeApiKeyResponse> {
    const key = await this.admit(request)
    if (key.isLeft()) return left(key.value)
    const hasScopes = FISCAL_SCOPES.every((scope) => key.value.scopes.includes(scope))
    const hasRoles = FISCAL_ROLES.every((wanted) =>
      key.value.roles.some((role) => role.module === wanted.module && role.role === wanted.role),
    )
    if (!hasScopes || !hasRoles)
      return left(new NotAllowedError('Fiscal service key lacks required access'))
    return right(
      await this.mint(request.tenantId, { ...key.value, scopes: FISCAL_SCOPES }, FISCAL_ROLES, {}),
    )
  }

  private async admit(
    request: ExchangeApiKeyRequest,
  ): Promise<
    Either<
      | InvalidCredentialsError
      | ScopeBeyondIssuerError
      | ApiKeyRateLimitedError
      | RateLimitUnavailableError,
      AuthenticatedApiKey
    >
  > {
    const key = await this.authenticate.execute(request)
    if (key.isLeft()) return left(key.value)
    let verdict: Awaited<ReturnType<ApiKeyRateLimiter['consume']>>
    try {
      verdict = await this.limiter.consume(key.value.apiKeyId, this.clock.now())
    } catch {
      return left(new RateLimitUnavailableError())
    }
    if (!verdict.allowed) return left(new ApiKeyRateLimitedError(verdict.retryAfterSeconds))
    return right(key.value)
  }

  private async mint(
    tenantId: string,
    key: AuthenticatedApiKey,
    roles: readonly RoleAssignment[],
    options: { readonly ttlSeconds?: number },
  ): Promise<ExchangedApiKey> {
    const minted = await this.signer.mint(
      { subject: `api-key:${key.apiKeyId}`, tenantId, roles },
      this.clock.now(),
      undefined,
      { scopes: key.scopes, issuer: key.issuedBy, ...options },
    )
    return {
      tenantId,
      apiKeyId: key.apiKeyId,
      accessToken: minted.token,
      expiresAt: minted.expiresAt,
      scopes: [...key.scopes],
    }
  }
}
