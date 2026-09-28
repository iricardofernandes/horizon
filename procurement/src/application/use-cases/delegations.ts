import { type Either, left, right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { NotAllowedError } from '@/core/errors/errors/not-allowed-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import {
  type ApprovalAuthority,
  ApprovalDelegation,
  ownAuthority,
} from '@/domain/controls/approval-delegation'
import { DELEGABLE_PERMISSIONS } from '@/domain/controls/duties'
import type { Clock } from '../ports/clock'
import type { ProcurementScope, ProcurementUnitOfWork } from '../ports/unit-of-work'
import type { CommandContext } from './commands'

export interface DelegationGrant {
  readonly permission: string
  readonly delegateId: string
  readonly startsAt: string
  readonly endsAt: string
  readonly reason?: string | undefined
}

const holds = (context: CommandContext, permission: string) =>
  context.approvals?.includes(permission) ?? false

function instantOf(value: string, pointer: string): Either<InvalidInputError, Date> {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? left(new InvalidInputError(pointer, 'must be an instant'))
    : right(date)
}

/**
 * Who may decide, and for whom: the person's own role when it grants the approval,
 * otherwise every active delegation lent to them for it, oldest first (ADR 0062). None is a
 * refusal.
 */
export async function resolveAuthorities(
  scope: ProcurementScope,
  context: CommandContext,
  permission: string,
  now: Date,
): Promise<Either<NotAllowedError, readonly ApprovalAuthority[]>> {
  if (holds(context, permission)) return right([ownAuthority(context.actor)])
  const lent = (await scope.delegations.findFor(context.actor, permission))
    .map((delegation) => delegation.authorityFor(context.actor, permission, now))
    .filter((authority): authority is ApprovalAuthority => authority !== null)
  return lent.length
    ? right(lent)
    : left(
        new NotAllowedError(
          'deciding this needs the approval through a role or an active delegation',
        ),
      )
}

/**
 * Decide with the first authority the record accepts. A delegate lent the same approval by
 * two people decides for whichever of them did not do the work; a refusal from every one
 * of them is the first refusal.
 */
export function decideWith<E>(
  authorities: readonly ApprovalAuthority[],
  decide: (authority: ApprovalAuthority) => Either<E, void>,
): Either<E, ApprovalAuthority> {
  let refusal: Either<E, ApprovalAuthority> | null = null
  for (const authority of authorities) {
    const decided = decide(authority)
    if (decided.isRight()) return right(authority)
    refusal ??= left(decided.value)
  }
  if (!refusal) throw new Error('decideWith needs at least one authority')
  return refusal
}

/** What an audit row adds when a decision was taken through a delegation. */
export function onBehalfOf(authority: ApprovalAuthority): Record<string, unknown> {
  return authority.onBehalfOf
    ? { onBehalfOf: authority.onBehalfOf, delegationId: authority.delegationId }
    : {}
}

/** An approver lends one approval they hold through their role, for a period. */
export class GrantDelegationUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: CommandContext
    grant: DelegationGrant
  }): Promise<Either<InvalidInputError | NotAllowedError, ApprovalDelegation>> {
    const { context, grant } = request
    if (!holds(context, grant.permission))
      return left(
        new NotAllowedError('only someone holding this approval through a role can lend it'),
      )
    const startsAt = instantOf(grant.startsAt, '/startsAt')
    if (startsAt.isLeft()) return left(startsAt.value)
    const endsAt = instantOf(grant.endsAt, '/endsAt')
    if (endsAt.isLeft()) return left(endsAt.value)
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const now = this.clock.now()
      const delegation = ApprovalDelegation.grant({
        tenantId: context.tenantId,
        permission: grant.permission,
        delegable: DELEGABLE_PERMISSIONS,
        delegatorId: context.actor,
        delegateId: grant.delegateId,
        startsAt: startsAt.value,
        endsAt: endsAt.value,
        reason: grant.reason ?? null,
        now,
      })
      if (delegation.isLeft()) return left(delegation.value)
      await scope.delegations.create(delegation.value)
      await scope.audit.append({
        actor: context.actor,
        action: 'delegation.granted',
        subjectType: 'delegation',
        subjectId: delegation.value.id.toString(),
        occurredAt: now,
        requestId: context.requestId,
        details: {
          permission: grant.permission,
          delegateId: grant.delegateId,
          startsAt: startsAt.value,
          endsAt: endsAt.value,
          ...(grant.reason ? { reason: grant.reason } : {}),
        },
      })
      return right(delegation.value)
    })
  }
}

/** The delegator, or anyone holding the approval through a role, ends it early. */
export class RevokeDelegationUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    delegationId: string
  }): Promise<Either<ResourceNotFoundError | NotAllowedError | ConflictError, ApprovalDelegation>> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const delegation = await scope.delegations.findForUpdate(request.delegationId)
      if (!delegation) return left(new ResourceNotFoundError('delegation was not found'))
      if (delegation.delegatorId !== context.actor && !holds(context, delegation.permission))
        return left(new NotAllowedError('only the delegator or an approver can revoke this'))
      const now = this.clock.now()
      const revoked = delegation.revoke(context.actor, now)
      if (revoked.isLeft()) return left(revoked.value)
      await scope.delegations.save(delegation)
      await scope.audit.append({
        actor: context.actor,
        action: 'delegation.revoked',
        subjectType: 'delegation',
        subjectId: request.delegationId,
        occurredAt: now,
        requestId: context.requestId,
        details: { permission: delegation.permission, delegateId: delegation.delegateId },
      })
      return right(delegation)
    })
  }
}

/** Approvers see every delegation; anyone else, the ones that name them. */
export class ListDelegationsUseCase {
  constructor(private readonly unitOfWork: ProcurementUnitOfWork) {}

  execute(context: CommandContext): Promise<readonly ApprovalDelegation[]> {
    const approver = DELEGABLE_PERMISSIONS.some((permission) => holds(context, permission))
    return this.unitOfWork.inTenant(context.tenantId, (scope) =>
      scope.delegations.list(approver ? null : context.actor),
    )
  }
}
