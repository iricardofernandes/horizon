import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import type { ApiKey } from '@/domain/entities/api-key'
import { InvalidCredentialsError } from '@/domain/errors/invalid-credentials-error'
import { ScopeBeyondIssuerError } from '@/domain/errors/scope-beyond-issuer-error'
import type { PasswordHasher } from '@/domain/services/password-hasher'
import { ApiKeyToken } from '@/domain/value-objects/api-key-token'
import type { RoleAssignment } from '@/domain/value-objects/role-assignments'
import type { Clock } from '../ports/clock'
import type { TenantScope, UnitOfWork } from '../ports/unit-of-work'

export interface AuthenticateApiKeyRequest {
  /** The tenant the request is addressed to. A key never authenticates across tenants. */
  readonly tenantId: string
  readonly presented: string
}

export interface AuthenticatedApiKey {
  readonly apiKeyId: string
  readonly issuedBy: string
  readonly scopes: readonly string[]
  /** The issuer's *current* assignments, so the receiving module expands those. */
  readonly roles: readonly RoleAssignment[]
}

export type AuthenticateApiKeyResponse = Either<
  InvalidCredentialsError | ScopeBeyondIssuerError,
  AuthenticatedApiKey
>

/**
 * Verify a presented API key.
 *
 * Lookup is one indexed equality on the plaintext prefix; only then is the Argon2id
 * comparison paid. The order matters — hashing first would mean an unauthenticated caller
 * could make the service allocate 19 MiB per guess.
 *
 * The **re-evaluation** at the end is the part ADR 0022 spends a paragraph on. A key's
 * scopes were a subset of its issuer's grants at creation; revoking that user's role does
 * not retroactively narrow keys they already minted. So the check is repeated against the
 * issuer's current assignments on every use, and a key that has outgrown its issuer is
 * refused and flagged rather than quietly continuing to work.
 */
@Injectable()
export class AuthenticateApiKeyUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
  ) {}

  async execute(request: AuthenticateApiKeyRequest): Promise<AuthenticateApiKeyResponse> {
    const parsed = ApiKeyToken.parse(request.presented)
    if (parsed.isLeft()) {
      await this.hasher.verifyDummy()
      return left(new InvalidCredentialsError())
    }

    const token = parsed.value
    const now = this.clock.now()

    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const apiKey = await scope.apiKeys.findByPrefix(token.prefix)
      if (apiKey === null || !apiKey.isUsableAt(now)) {
        await this.hasher.verifyDummy()
        return left(new InvalidCredentialsError())
      }

      if (!(await apiKey.verifySecret(token.secret, this.hasher)))
        return left(new InvalidCredentialsError())

      return this.authorise(scope, apiKey, now)
    })
  }

  private async authorise(
    scope: TenantScope,
    apiKey: ApiKey,
    now: Date,
  ): Promise<AuthenticateApiKeyResponse> {
    const issuer = await scope.users.findById(apiKey.issuer())
    if (issuer === null || !issuer.canAuthenticate()) return left(new InvalidCredentialsError())

    const scopes = apiKey.grantedScopes()
    if (!issuer.canMint(scopes)) {
      await this.flagOvergrown(scope, apiKey, issuer.scopesBeyondReach(scopes), now)
      return left(new ScopeBeyondIssuerError(issuer.scopesBeyondReach(scopes)))
    }

    await this.recordUse(scope, apiKey, now)

    return right({
      apiKeyId: apiKey.id.toString(),
      issuedBy: apiKey.issuer(),
      scopes: scopes.values,
      roles: issuer.claims().roles,
    })
  }

  /** At most one write a minute per key, so a hot key does not turn reads into writes. */
  private async recordUse(scope: TenantScope, apiKey: ApiKey, now: Date): Promise<void> {
    if (!apiKey.shouldRecordUse(now)) return
    apiKey.recordUse(now)
    await scope.apiKeys.save(apiKey)
  }

  private async flagOvergrown(
    scope: TenantScope,
    apiKey: ApiKey,
    modules: readonly string[],
    now: Date,
  ): Promise<void> {
    await scope.audit.append({
      actor: { type: 'api-key', id: apiKey.id.toString() },
      subjectType: 'api-key',
      subjectId: apiKey.id.toString(),
      action: 'api-key.exceeds-issuer',
      after: { modulesBeyondIssuer: [...modules] },
      occurredAt: now,
    })
  }
}
