import { type Either, left, right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { AccountProfile } from '@/domain/entities/account'
import { Segment, Tags } from '@/domain/value-objects/crm-values'
import type { Clock } from '../ports/clock'
import type { CrmScope, CrmUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext } from './commands'

export interface AccountProfileInput {
  /** `null` leaves the account without an owner; absent leaves the owner as it is. */
  readonly ownerId?: string | null | undefined
  readonly segment?: string | null | undefined
  readonly tags?: readonly string[] | undefined
}

function profileOf(input: AccountProfileInput): Either<InvalidInputError, Partial<AccountProfile>> {
  const profile: { -readonly [K in keyof AccountProfile]?: AccountProfile[K] } = {}
  if (input.ownerId !== undefined) profile.ownerId = input.ownerId
  if (input.segment !== undefined) {
    if (input.segment === null || !input.segment.trim()) profile.segment = null
    else {
      const segment = Segment.create(input.segment)
      if (segment.isLeft()) return left(segment.value)
      profile.segment = segment.value
    }
  }
  if (input.tags !== undefined) {
    const tags = Tags.of(input.tags)
    if (tags.isLeft()) return left(tags.value)
    profile.tags = tags.value
  }
  return right(profile)
}

/** An owner must be a user CRM knows and who has not been disabled. */
async function ownerAvailable(
  scope: CrmScope,
  ownerId: string | null | undefined,
): Promise<InvalidInputError | null> {
  if (ownerId === undefined || ownerId === null) return null
  const owner = await scope.owners.find(ownerId)
  if (!owner) return new InvalidInputError('/ownerId', 'is not a user of this workspace')
  if (!owner.active) return new InvalidInputError('/ownerId', 'is a disabled user')
  return null
}

/**
 * Change who looks after an account, its segment or its tags. Whether the caller may
 * reassign owners is decided at the boundary; this decides whether the change is valid.
 */
export class UpdateAccountProfileUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly context: CommandContext
    readonly accountId: string
    readonly profile: AccountProfileInput
  }): Promise<
    Either<
      InvalidInputError | ResourceNotFoundError | ConflictError,
      { changed: readonly string[] }
    >
  > {
    const profile = profileOf(request.profile)
    if (profile.isLeft()) return left(profile.value)
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const account = await scope.accounts.findById(request.accountId)
      if (!account) return left(new ResourceNotFoundError('account was not found'))
      const refused = await ownerAvailable(scope, profile.value.ownerId)
      if (refused) return left(refused)
      const now = this.clock.now()
      const changed = account.describe(profile.value, now)
      if (changed.isLeft()) return left(changed.value)
      if (!changed.value.length) return right({ changed: [] })
      await scope.accounts.save(account)
      await audit(scope, context, {
        action: 'account.profile-changed',
        subjectType: 'account',
        subjectId: request.accountId,
        occurredAt: now,
        details: {
          changed: changed.value,
          ...(changed.value.includes('ownerId') ? { ownerId: profile.value.ownerId ?? null } : {}),
        },
      })
      return right({ changed: changed.value })
    })
  }
}
