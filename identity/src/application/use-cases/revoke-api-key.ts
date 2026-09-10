import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Actor } from '@/domain/audit/audit-entry'
import type { Clock } from '../ports/clock'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface RevokeApiKeyRequest {
  readonly tenantId: string
  readonly apiKeyId: string
  readonly actor: Actor
  readonly requestId?: string | null
}

export type RevokeApiKeyResponse = Either<ResourceNotFoundError | ConflictError, null>

/**
 * Revocation is immediate (ADR 0022).
 *
 * The `api-key.revoked` event goes to the outbox in the same transaction as the state
 * change, which is what lets the verified-key cache be invalidated everywhere without a
 * second, unreliable notification path.
 */
@Injectable()
export class RevokeApiKeyUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: RevokeApiKeyRequest): Promise<RevokeApiKeyResponse> {
    const now = this.clock.now()

    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const apiKey = await scope.apiKeys.findById(request.apiKeyId)
      if (apiKey === null) return left(new ResourceNotFoundError('api key'))

      const revoked = apiKey.revoke(now)
      if (revoked.isLeft()) return left(revoked.value)

      await scope.apiKeys.save(apiKey)
      await scope.audit.append({
        actor: request.actor,
        subjectType: 'api-key',
        subjectId: request.apiKeyId,
        action: 'api-key.revoked',
        requestId: request.requestId ?? null,
        occurredAt: now,
      })

      return right(null)
    })
  }
}
