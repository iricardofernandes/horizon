import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import { NotAllowedError } from '@/core/errors/errors/not-allowed-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Actor } from '@/domain/audit/audit-entry'
import type { RefreshTokenFamiliesRepository } from '@/domain/repositories/refresh-token-families-repository'
import type { Clock } from '../ports/clock'
import type { IdentityPolicy } from '../ports/identity-policy'
import type { TokenDenylist } from '../ports/token-denylist'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface DisableUserRequest {
  readonly tenantId: string
  readonly userId: string
  readonly actor: Actor
  readonly requestId?: string | null
}

export type DisableUserResponse = Either<
  ResourceNotFoundError | ConflictError | NotAllowedError,
  null
>

/**
 * Revoke someone's access, everywhere, now.
 *
 * Three things have to happen or the fourth is a lie: the user row is marked disabled so
 * nothing new is issued, every refresh family is destroyed so no session can be extended,
 * and the subject is denylisted for the access token lifetime so the token already in
 * flight stops working. Without the third, "disabled" means "disabled in fifteen minutes"
 * (ADR 0021).
 *
 * Disabling yourself is refused. It is almost always a mistake, and when it is not, it is
 * still better done by someone who will still be able to undo it.
 */
@Injectable()
export class DisableUserUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly families: RefreshTokenFamiliesRepository,
    private readonly denylist: TokenDenylist,
    private readonly policy: IdentityPolicy,
    private readonly clock: Clock,
  ) {}

  async execute(request: DisableUserRequest): Promise<DisableUserResponse> {
    if (request.actor.type === 'user' && request.actor.id === request.userId)
      return left(new NotAllowedError('you cannot disable your own account'))

    const now = this.clock.now()

    const outcome = await this.unitOfWork.inTenant<
      Either<ResourceNotFoundError | ConflictError, null>
    >(request.tenantId, async (scope) => {
      const user = await scope.users.findById(request.userId)
      if (user === null) return left(new ResourceNotFoundError('user'))

      const disabled = user.disable(now)
      if (disabled.isLeft()) return left(disabled.value)

      await scope.users.save(user)
      await scope.audit.append({
        actor: request.actor,
        subjectType: 'user',
        subjectId: request.userId,
        action: 'user.disabled',
        dataSubjectId: request.userId,
        requestId: request.requestId ?? null,
        occurredAt: now,
      })
      return right(null)
    })

    if (outcome.isLeft()) return outcome

    await this.endEverySession(request, now)
    return right(null)
  }

  private async endEverySession(request: DisableUserRequest, now: Date): Promise<void> {
    const families = await this.families.findAllForUser(request.tenantId, request.userId)
    for (const family of families)
      await this.families.delete(request.tenantId, family.id.toString())

    await this.denylist.revokeSubject(
      request.userId,
      new Date(now.getTime() + this.policy.accessTokenTtlSeconds() * 1000),
    )
  }
}
