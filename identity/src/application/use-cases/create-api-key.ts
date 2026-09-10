import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Actor } from '@/domain/audit/audit-entry'
import { ApiKey } from '@/domain/entities/api-key'
import { ScopeBeyondIssuerError } from '@/domain/errors/scope-beyond-issuer-error'
import type { PasswordHasher } from '@/domain/services/password-hasher'
import { ApiKeyScopes } from '@/domain/value-objects/api-key-scopes'
import { ApiKeyToken } from '@/domain/value-objects/api-key-token'
import type { Clock } from '../ports/clock'
import type { IdentityPolicy } from '../ports/identity-policy'
import type { SecretGenerator } from '../ports/secret-generator'
import type { TenantScope, UnitOfWork } from '../ports/unit-of-work'

export interface CreateApiKeyRequest {
  readonly tenantId: string
  readonly issuedBy: string
  readonly name: string
  readonly scopes: readonly string[]
  readonly expiresAt?: Date | null
  readonly actor: Actor
  readonly requestId?: string | null
}

export type CreateApiKeyResponse = Either<
  InvalidInputError | ResourceNotFoundError | ScopeBeyondIssuerError,
  {
    readonly apiKeyId: string
    readonly prefix: string
    /** The full credential. Shown **once**, here, and never recoverable (ADR 0022). */
    readonly token: string
  }
>

/**
 * Mint a key.
 *
 * The subset rule is enforced, not documented: a key's scopes must be grantable by the
 * user issuing it, and "grantable" means every module the scopes reach is a module the
 * issuer holds some role in. Identity can answer that from the opaque pairs it stores,
 * without expanding a single role into a permission — which is exactly the line ADR 0023
 * draws. The module receiving the request applies the precise check on arrival.
 *
 * The token is returned once. What is stored is the 24-character prefix in plaintext,
 * indexed, and an Argon2id hash of the 32-character secret. There is no code path that
 * can show the secret again, which is the point of there not being one.
 */
@Injectable()
export class CreateApiKeyUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly hasher: PasswordHasher,
    private readonly secrets: SecretGenerator,
    private readonly policy: IdentityPolicy,
    private readonly clock: Clock,
  ) {}

  async execute(request: CreateApiKeyRequest): Promise<CreateApiKeyResponse> {
    const scopes = ApiKeyScopes.create(request.scopes)
    if (scopes.isLeft()) return left(scopes.value)

    const token = ApiKeyToken.create({
      environment: this.policy.apiKeyEnvironment(),
      prefix: this.secrets.alphanumeric(ApiKeyToken.PREFIX_LENGTH),
      secret: this.secrets.alphanumeric(ApiKeyToken.SECRET_LENGTH),
    })
    const secretHash = await this.hasher.hash(token.secret)
    const now = this.clock.now()

    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const issuer = await scope.users.findById(request.issuedBy)
      if (issuer === null) return left(new ResourceNotFoundError('user'))

      if (!issuer.canMint(scopes.value))
        return left(new ScopeBeyondIssuerError(issuer.scopesBeyondReach(scopes.value)))

      const apiKey = ApiKey.issue({
        tenantId: request.tenantId,
        issuedBy: request.issuedBy,
        name: request.name,
        token,
        secretHash,
        scopes: scopes.value,
        ...(request.expiresAt == null ? {} : { expiresAt: request.expiresAt }),
        now,
      })

      await this.persist(scope, apiKey, request, now)
      return right({
        apiKeyId: apiKey.id.toString(),
        prefix: token.prefix,
        token: token.toString(),
      })
    })
  }

  private async persist(
    scope: TenantScope,
    apiKey: ApiKey,
    request: CreateApiKeyRequest,
    now: Date,
  ): Promise<void> {
    await scope.apiKeys.create(apiKey)
    await scope.audit.append({
      actor: request.actor,
      subjectType: 'api-key',
      subjectId: apiKey.id.toString(),
      action: 'api-key.created',
      // `secret` and `secretHash` are on the redaction list, and the fact that they were
      // redacted is inside the hash — so nobody can hide a change by declaring a field
      // sensitive after the fact (ADR 0025).
      after: { name: request.name, scopes: [...request.scopes], issuedBy: request.issuedBy },
      requestId: request.requestId ?? null,
      occurredAt: now,
    })
  }
}
