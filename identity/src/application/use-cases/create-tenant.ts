import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { DataSubjectKey } from '@/domain/entities/data-subject-key'
import { Tenant } from '@/domain/entities/tenant'
import { User } from '@/domain/entities/user'
import type { TenantDirectory } from '@/domain/repositories/tenant-directory'
import type { PasswordHasher } from '@/domain/services/password-hasher'
import { Email } from '@/domain/value-objects/email'
import { PasswordHash } from '@/domain/value-objects/password-hash'
import { PersonName } from '@/domain/value-objects/person-name'
import { RoleAssignments } from '@/domain/value-objects/role-assignments'
import { TenantName } from '@/domain/value-objects/tenant-name'
import { TenantSlug } from '@/domain/value-objects/tenant-slug'
import { Timezone } from '@/domain/value-objects/timezone'
import type { Clock } from '../ports/clock'
import type { SecretGenerator } from '../ports/secret-generator'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface CreateTenantRequest {
  readonly name: string
  readonly slug: string
  readonly timezone: string
  readonly owner: {
    readonly email: string
    readonly name: string
    readonly password: string
  }
}

export type CreateTenantResponse = Either<
  InvalidInputError | ConflictError,
  { readonly tenantId: string; readonly ownerId: string }
>

/**
 * Sign-up: a tenant and the one user who can administer it, in a single transaction.
 *
 * Creating a tenant is the only operation in the module that has no tenant context to
 * inherit, and it does not need a privileged path to get one. The tenant id is generated
 * first and `app.current_tenant` is opened on it, so the insert happens under the same
 * RLS policy as every other write in the system — `tenants.id = current_tenant` — with no
 * exception carved out and nothing to re-justify later.
 *
 * The slug is registered in the unscoped directory inside that same transaction, so a
 * tenant and its login handle cannot exist without each other (ADR 0037).
 */
@Injectable()
export class CreateTenantUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly directory: TenantDirectory,
    private readonly hasher: PasswordHasher,
    private readonly secrets: SecretGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(request: CreateTenantRequest): Promise<CreateTenantResponse> {
    const inputs = this.parse(request)
    if (inputs.isLeft()) return left(inputs.value)

    const { name, slug, timezone, email, ownerName } = inputs.value

    if (await this.directory.slugExists(slug.value))
      return left(new ConflictError(`the workspace handle "${slug.value}" is already taken`))

    const now = this.clock.now()
    const tenant = Tenant.register({ name, slug, timezone, now })
    const tenantId = tenant.id.toString()

    const hashed = PasswordHash.create(await this.hasher.hash(request.owner.password))
    if (hashed.isLeft()) return left(hashed.value)

    const owner = User.register({
      tenantId,
      email,
      name: ownerName,
      passwordHash: hashed.value,
      // The first user is the only one who can grant anything, so they must be able to.
      roles: RoleAssignments.of([{ module: 'identity', role: 'owner' }]),
      now,
    })

    await this.unitOfWork.inTenant(tenantId, async (scope) => {
      await scope.tenants.create(tenant)
      await this.directory.register(slug.value, tenantId)
      await scope.dataSubjectKeys.create(
        DataSubjectKey.issue({
          tenantId,
          subjectId: owner.id.toString(),
          material: this.secrets.keyMaterial(),
          now,
        }),
      )
      await scope.users.create(owner)
      await scope.audit.append({
        actor: { type: 'system', id: null },
        subjectType: 'tenant',
        subjectId: tenantId,
        action: 'tenant.created',
        after: { name: name.value, slug: slug.value, timezone: timezone.value },
        occurredAt: now,
      })
    })

    return right({ tenantId, ownerId: owner.id.toString() })
  }

  /**
   * Every value object at once, so a malformed request produces its first real failure
   * rather than a hash computed for a body that was never going to be accepted.
   */
  private parse(request: CreateTenantRequest): Either<
    InvalidInputError,
    {
      name: TenantName
      slug: TenantSlug
      timezone: Timezone
      email: Email
      ownerName: PersonName
    }
  > {
    const name = TenantName.create(request.name)
    if (name.isLeft()) return left(name.value)

    const slug = TenantSlug.create(request.slug)
    if (slug.isLeft()) return left(slug.value)

    const timezone = Timezone.create(request.timezone)
    if (timezone.isLeft()) return left(timezone.value)

    const email = Email.create(request.owner.email, '/owner/email')
    if (email.isLeft()) return left(email.value)

    const ownerName = PersonName.create(request.owner.name, '/owner/name')
    if (ownerName.isLeft()) return left(ownerName.value)

    return right({
      name: name.value,
      slug: slug.value,
      timezone: timezone.value,
      email: email.value,
      ownerName: ownerName.value,
    })
  }
}
