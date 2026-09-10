import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { Actor } from '@/domain/audit/audit-entry'
import { DataSubjectKey } from '@/domain/entities/data-subject-key'
import { User } from '@/domain/entities/user'
import type { PasswordHasher } from '@/domain/services/password-hasher'
import { Email } from '@/domain/value-objects/email'
import { PasswordHash } from '@/domain/value-objects/password-hash'
import { PersonName } from '@/domain/value-objects/person-name'
import { type RoleAssignment, RoleAssignments } from '@/domain/value-objects/role-assignments'
import type { Clock } from '../ports/clock'
import type { SecretGenerator } from '../ports/secret-generator'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface RegisterUserRequest {
  readonly tenantId: string
  readonly email: string
  readonly name: string
  readonly password: string
  readonly roles: readonly RoleAssignment[]
  readonly actor: Actor
}

export type RegisterUserResponse = Either<
  InvalidInputError | ConflictError,
  { readonly userId: string }
>

/**
 * Add a user to an existing tenant.
 *
 * The data-subject key is created **first and in the same transaction** as the user, not
 * lazily on first write. A user row whose personal columns have no key is a row that
 * cannot be read back and cannot be erased, and the window in which that is possible is
 * closed here rather than handled later (ADR 0026).
 */
@Injectable()
export class RegisterUserUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly hasher: PasswordHasher,
    private readonly secrets: SecretGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(request: RegisterUserRequest): Promise<RegisterUserResponse> {
    const email = Email.create(request.email)
    if (email.isLeft()) return left(email.value)

    const name = PersonName.create(request.name)
    if (name.isLeft()) return left(name.value)

    const hashed = PasswordHash.create(await this.hasher.hash(request.password))
    if (hashed.isLeft()) return left(hashed.value)

    const now = this.clock.now()

    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const existing = await scope.users.findByEmail(email.value)
      if (existing !== null)
        return left(new ConflictError('a user with that email already exists in this tenant'))

      const user = User.register({
        tenantId: request.tenantId,
        email: email.value,
        name: name.value,
        passwordHash: hashed.value,
        roles: RoleAssignments.of(request.roles),
        now,
      })

      await scope.dataSubjectKeys.create(
        DataSubjectKey.issue({
          tenantId: request.tenantId,
          subjectId: user.id.toString(),
          material: this.secrets.keyMaterial(),
          now,
        }),
      )
      await scope.users.create(user)
      await scope.audit.append({
        actor: request.actor,
        subjectType: 'user',
        subjectId: user.id.toString(),
        action: 'user.registered',
        // The diff is the substance of an audit entry, so the email belongs in it. It is
        // encrypted under this subject's own key before it is hashed, which is what lets
        // an erasure destroy it later without breaking the chain (ADR 0025, ADR 0026).
        after: { email: email.value.value, roles: [...request.roles] },
        dataSubjectId: user.id.toString(),
        occurredAt: now,
      })

      return right({ userId: user.id.toString() })
    })
  }
}
