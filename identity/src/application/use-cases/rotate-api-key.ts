import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Actor } from '@/domain/audit/audit-entry'
import { ScopeBeyondIssuerError } from '@/domain/errors/scope-beyond-issuer-error'
import type { PasswordHasher } from '@/domain/services/password-hasher'
import { ApiKeyToken } from '@/domain/value-objects/api-key-token'
import type { Clock } from '../ports/clock'
import type { IdentityPolicy } from '../ports/identity-policy'
import type { SecretGenerator } from '../ports/secret-generator'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface RotateApiKeyRequest {
  readonly tenantId: string
  readonly apiKeyId: string
  /** How long the outgoing key keeps working. Zero is allowed and means "immediately". */
  readonly overlapSeconds: number
  readonly actor: Actor
  readonly requestId?: string | null
}

export type RotateApiKeyResponse = Either<
  ResourceNotFoundError | ConflictError | InvalidInputError | ScopeBeyondIssuerError,
  {
    readonly apiKeyId: string
    readonly prefix: string
    readonly token: string
    readonly previousKeyValidUntil: Date
  }
>

/**
 * Issue a replacement with the same scopes, and keep the old one alive for a window.
 *
 * The overlap is the whole reason rotation is not "revoke, then create": an integration
 * that cannot be redeployed atomically needs a period where both credentials
 * authenticate. The outgoing key is marked superseded rather than revoked, and
 * `ApiKey.isUsableAt` treats the end of the overlap exactly like an expiry — so no caller
 * has to remember that superseded is a third way for a key to stop working.
 *
 * The replacement is checked against the issuer's *current* grants, not the scopes it is
 * inheriting: rotating a key must not be a way to renew reach the issuer has since lost.
 */
@Injectable()
export class RotateApiKeyUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly hasher: PasswordHasher,
    private readonly secrets: SecretGenerator,
    private readonly policy: IdentityPolicy,
    private readonly clock: Clock,
  ) {}

  async execute(request: RotateApiKeyRequest): Promise<RotateApiKeyResponse> {
    const token = ApiKeyToken.create({
      environment: this.policy.apiKeyEnvironment(),
      prefix: this.secrets.alphanumeric(ApiKeyToken.PREFIX_LENGTH),
      secret: this.secrets.alphanumeric(ApiKeyToken.SECRET_LENGTH),
    })
    const secretHash = await this.hasher.hash(token.secret)
    const now = this.clock.now()
    const validUntil = new Date(now.getTime() + Math.max(1, request.overlapSeconds) * 1000)

    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const outgoing = await scope.apiKeys.findById(request.apiKeyId)
      if (outgoing === null) return left(new ResourceNotFoundError('api key'))

      const issuer = await scope.users.findById(outgoing.issuer())
      if (issuer === null) return left(new ResourceNotFoundError('user'))

      const scopes = outgoing.grantedScopes()
      if (!issuer.canMint(scopes))
        return left(new ScopeBeyondIssuerError(issuer.scopesBeyondReach(scopes)))

      const rotated = outgoing.rotate({ token, secretHash, until: validUntil, now })
      if (rotated.isLeft()) return left(rotated.value)
      const replacement = rotated.value

      await scope.apiKeys.save(outgoing)
      await scope.apiKeys.create(replacement)
      await scope.audit.append({
        actor: request.actor,
        subjectType: 'api-key',
        subjectId: request.apiKeyId,
        action: 'api-key.rotated',
        after: { replacementId: replacement.id.toString(), overlapEndsAt: validUntil },
        requestId: request.requestId ?? null,
        occurredAt: now,
      })

      return right({
        apiKeyId: replacement.id.toString(),
        prefix: token.prefix,
        token: token.toString(),
        previousKeyValidUntil: validUntil,
      })
    })
  }
}
