import { type Either, left, right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { SegregationOfDutiesError } from '@/core/errors/errors/segregation-of-duties-error'
import { type ApprovalAuthority, ownAuthority } from '@/domain/controls/approval-delegation'
import { APPROVE_PAYABLE } from '@/domain/controls/duties'
import type { Title } from '@/domain/entities/title'
import type { ApprovalPolicy } from '@/domain/repositories/title-repositories'
import { Currency, Money } from '@/domain/value-objects/financial-values'
import type { Reason } from '@/domain/value-objects/title-values'
import type { Clock } from '../ports/clock'
import type { FinancialScope, FinancialUnitOfWork } from '../ports/unit-of-work'
import { decideWith, onBehalfOf, resolveAuthorities } from './delegations'
import { type CommandContext, type Failure, reasonOf } from './title-inputs'

type Decision =
  | { readonly kind: 'request' }
  | { readonly kind: 'approve' }
  | { readonly kind: 'reject'; readonly reason: Reason }

const ACTIONS = {
  request: 'payable.approval-requested',
  approve: 'payable.approved',
  reject: 'payable.rejected',
} as const

/**
 * Asking for, granting and refusing approval of a payable draft. None of these moves money,
 * so none needs an idempotency key: repeating one is refused by the approval state itself.
 *
 * Deciding takes the approval through a role or an active delegation, and never falls to
 * whoever drafted or asked, in person or through a delegation they lent (ADR 0062).
 */
export class DecidePayableApprovalUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  request(context: CommandContext, titleId: string) {
    return this.decide(context, titleId, { kind: 'request' })
  }

  approve(context: CommandContext, titleId: string) {
    return this.decide(context, titleId, { kind: 'approve' })
  }

  reject(context: CommandContext, titleId: string, reason: string) {
    const parsed = reasonOf(reason)
    if (parsed.isLeft())
      return Promise.resolve(left<Failure, { approvalState: string }>(parsed.value))
    return this.decide(context, titleId, { kind: 'reject', reason: parsed.value })
  }

  private decide(
    context: CommandContext,
    titleId: string,
    decision: Decision,
  ): Promise<Either<Failure, { approvalState: string }>> {
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const title = await scope.titles.findForUpdate(titleId)
      if (title?.direction !== 'payable')
        return left(new ResourceNotFoundError('payable was not found'))
      const now = this.clock.now()
      const authorities =
        decision.kind === 'request'
          ? right<never, readonly ApprovalAuthority[]>([ownAuthority(context.actor)])
          : await resolveAuthorities(scope, context, APPROVE_PAYABLE, now)
      if (authorities.isLeft()) return left(authorities.value)
      const decided = decideWith(authorities.value, (authority) =>
        apply(title, decision, authority, now),
      )
      if (decided.isLeft()) return left(decided.value)
      await scope.titles.save(title)
      await appendDecision(scope, context, title, decision, decided.value, now)
      return right({ approvalState: title.approvalState })
    })
  }
}

function apply(
  title: Title,
  decision: Decision,
  authority: ApprovalAuthority,
  now: Date,
): Either<ConflictError | SegregationOfDutiesError, void> {
  switch (decision.kind) {
    case 'request':
      return title.requestApproval(authority.actor, now)
    case 'approve':
      return title.approve(authority, now)
    default:
      return title.reject(authority, decision.reason, now)
  }
}

function appendDecision(
  scope: FinancialScope,
  context: CommandContext,
  title: Title,
  decision: Decision,
  authority: ApprovalAuthority,
  occurredAt: Date,
) {
  return scope.audit.append({
    actor: context.actor,
    action: ACTIONS[decision.kind],
    subjectType: 'title',
    subjectId: title.id.toString(),
    occurredAt,
    requestId: context.requestId,
    details: {
      ...(decision.kind === 'reject' ? { reason: decision.reason.value } : {}),
      ...onBehalfOf(authority),
    },
  })
}

/** Payables at or above the threshold need a second person; below it they post directly. */
export class DefineApprovalPolicyUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: CommandContext
    currency: string
    threshold: string
  }): Promise<Either<InvalidInputError, ApprovalPolicy>> {
    const currency = Currency.create(request.currency)
    if (currency.isLeft()) return left(currency.value)
    const threshold = Money.create(request.threshold, currency.value)
    if (threshold.isLeft())
      return left(new InvalidInputError('/threshold', threshold.value.message))
    return this.unitOfWork.inTenant(request.context.tenantId, async (scope) => {
      const now = this.clock.now()
      const policy: ApprovalPolicy = {
        direction: 'payable',
        currency: currency.value.value,
        threshold: threshold.value.amount,
        updatedAt: now,
      }
      await scope.approvalPolicies.save(policy)
      await scope.audit.append({
        actor: request.context.actor,
        action: 'approval-policy.defined',
        subjectType: 'approval-policy',
        subjectId: request.context.tenantId,
        occurredAt: now,
        requestId: request.context.requestId,
        details: { direction: 'payable', currency: policy.currency, threshold: policy.threshold },
      })
      return right(policy)
    })
  }
}
