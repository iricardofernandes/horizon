import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Actor } from '@/domain/audit/audit-entry'
import type { RoleAssignment } from '@/domain/value-objects/role-assignments'
import type { Clock } from '../ports/clock'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface AssignRoleRequest {
  readonly tenantId: string
  readonly userId: string
  readonly assignment: RoleAssignment
  readonly operation: 'grant' | 'revoke'
  readonly actor: Actor
  readonly requestId?: string | null
}

export type AssignRoleResponse = Either<
  ResourceNotFoundError | ConflictError,
  { readonly roles: readonly RoleAssignment[] }
>

/**
 * Grant or revoke one `{ module, role }` pair.
 *
 * Identity records the pair and cannot say what it permits — expansion happens in the
 * module that owns the subject, against its own static map (ADR 0023). Whether the *name*
 * is one the named module actually declares is a wire-contract question, answered by
 * `@horizon/contracts` at the HTTP boundary before this use case is reached.
 *
 * Revoking a role narrows the API keys the user has already issued, because a key is
 * re-evaluated against its issuer's current assignments on every use (ADR 0022). That is
 * why this is one use case with an `operation` rather than two that could drift.
 */
@Injectable()
export class AssignRoleUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: AssignRoleRequest): Promise<AssignRoleResponse> {
    const now = this.clock.now()

    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const user = await scope.users.findById(request.userId)
      if (user === null) return left(new ResourceNotFoundError('user'))

      const before = user.claims().roles
      const changed =
        request.operation === 'grant'
          ? user.grant(request.assignment, now)
          : user.revokeRole(request.assignment, now)
      if (changed.isLeft()) return left(changed.value)

      await scope.users.save(user)
      await scope.audit.append({
        actor: request.actor,
        subjectType: 'user',
        subjectId: request.userId,
        action: request.operation === 'grant' ? 'user.role.granted' : 'user.role.revoked',
        before: { roles: [...before] },
        after: { roles: [...user.claims().roles] },
        requestId: request.requestId ?? null,
        occurredAt: now,
      })

      return right({ roles: user.claims().roles })
    })
  }
}
