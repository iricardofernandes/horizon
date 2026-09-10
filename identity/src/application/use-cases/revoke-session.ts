import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { RefreshTokenFamiliesRepository } from '@/domain/repositories/refresh-token-families-repository'
import type { Clock } from '../ports/clock'
import type { TokenDenylist } from '../ports/token-denylist'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface RevokeSessionRequest {
  readonly tenantId: string
  readonly userId: string
  readonly familyId: string
  /** The `jti` of the access token presenting this request, so it dies too. */
  readonly jti: string
  readonly accessTokenExpiresAt: Date
  readonly requestId?: string | null
}

export type RevokeSessionResponse = Either<ResourceNotFoundError, null>

/**
 * Log out — which has to mean two things, because there are two credentials.
 *
 * The refresh family is deleted, so no new access token can be minted. The presented
 * access token is denylisted for its remaining lifetime, so the one already in the
 * client's hand stops working too. Doing only the first would leave a logged-out user
 * authenticated for up to fifteen minutes, which is the difference between logging out
 * and appearing to.
 */
@Injectable()
export class RevokeSessionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly families: RefreshTokenFamiliesRepository,
    private readonly denylist: TokenDenylist,
    private readonly clock: Clock,
  ) {}

  async execute(request: RevokeSessionRequest): Promise<RevokeSessionResponse> {
    const family = await this.families.findById(request.tenantId, request.familyId)
    if (family === null || family.userId() !== request.userId)
      return left(new ResourceNotFoundError('session'))

    family.end('logout')
    await this.families.delete(request.tenantId, request.familyId)
    await this.denylist.revoke(request.jti, request.accessTokenExpiresAt)

    const now = this.clock.now()
    await this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      await scope.audit.append({
        actor: { type: 'user', id: request.userId },
        subjectType: 'session',
        subjectId: request.familyId,
        action: 'session.revoked',
        requestId: request.requestId ?? null,
        occurredAt: now,
      })
    })

    return right(null)
  }
}
