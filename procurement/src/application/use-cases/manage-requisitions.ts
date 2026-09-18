import { type Either, left, right } from '@/core/either'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { PurchaseRequisition } from '@/domain/entities/purchase-requisition'
import type { Clock } from '../ports/clock'
import type { ProcurementUnitOfWork } from '../ports/unit-of-work'
import {
  audit,
  type CommandContext,
  type Failure,
  type IdempotentContext,
  type Outcome,
  once,
} from './commands'
import { dateOf, type LineInput, memoOf, reasonOf, requisitionLinesOf } from './inputs'

export interface RequisitionInput {
  readonly warehouseId: string
  readonly neededBy: string
  readonly justification?: string | undefined
  readonly lines: readonly LineInput[]
}

/** Write down what somebody needs. Nothing is committed and nobody is told yet. */
export class OpenRequisitionUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    requisition: RequisitionInput
  }): Outcome<{ id: string }> {
    const { context, requisition } = request
    const neededBy = dateOf(requisition.neededBy, '/neededBy')
    if (neededBy.isLeft()) return left(neededBy.value)
    const justification = memoOf(requisition.justification, '/justification')
    if (justification.isLeft()) return left(justification.value)
    return once(this.unitOfWork, context, 'requisition.open', requisition, async (scope) => {
      const lines = await requisitionLinesOf(scope, requisition.lines)
      if (lines.isLeft()) return left(lines.value)
      const now = this.clock.now()
      const opened = PurchaseRequisition.open({
        tenantId: context.tenantId,
        requestedBy: context.actor,
        warehouseId: requisition.warehouseId,
        neededBy: neededBy.value,
        justification: justification.value,
        lines: lines.value,
        now,
      })
      if (opened.isLeft()) return left(opened.value)
      await scope.requisitions.create(opened.value)
      await audit(scope, context, {
        action: 'requisition.opened',
        subjectType: 'requisition',
        subjectId: opened.value.id.toString(),
        occurredAt: now,
        details: { warehouseId: requisition.warehouseId, lines: requisition.lines.length },
      })
      return right({ id: opened.value.id.toString() })
    })
  }
}

export class ReviseRequisitionUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    requisitionId: string
    requisition: Omit<RequisitionInput, 'warehouseId'>
  }): Promise<Either<Failure, void>> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const neededBy = dateOf(request.requisition.neededBy, '/neededBy')
      if (neededBy.isLeft()) return left(neededBy.value)
      const justification = memoOf(request.requisition.justification, '/justification')
      if (justification.isLeft()) return left(justification.value)
      const requisition = await scope.requisitions.findForUpdate(request.requisitionId)
      if (!requisition) return left(new ResourceNotFoundError('requisition was not found'))
      const lines = await requisitionLinesOf(scope, request.requisition.lines)
      if (lines.isLeft()) return left(lines.value)
      const now = this.clock.now()
      const revised = requisition.revise(
        { neededBy: neededBy.value, justification: justification.value, lines: lines.value },
        now,
      )
      if (revised.isLeft()) return left(revised.value)
      await scope.requisitions.save(requisition)
      await audit(scope, context, {
        action: 'requisition.revised',
        subjectType: 'requisition',
        subjectId: request.requisitionId,
        occurredAt: now,
        details: { lines: request.requisition.lines.length },
      })
      return right(undefined)
    })
  }
}

type Decision =
  | { readonly kind: 'submit' }
  | { readonly kind: 'approve' }
  | { readonly kind: 'reject'; readonly reason: string }
  | { readonly kind: 'cancel'; readonly reason: string }

const ACTIONS = {
  submit: 'requisition.submitted',
  approve: 'requisition.approved',
  reject: 'requisition.rejected',
  cancel: 'requisition.cancelled',
} as const

/**
 * Moving a requisition along: submitting it, deciding it, withdrawing it.
 *
 * None of these commits money, so none takes an idempotency key: repeating one is refused
 * by the requisition's own state, which is a better answer than a remembered receipt.
 */
export class DecideRequisitionUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  submit(context: CommandContext, requisitionId: string) {
    return this.decide(context, requisitionId, { kind: 'submit' })
  }

  approve(context: CommandContext, requisitionId: string) {
    return this.decide(context, requisitionId, { kind: 'approve' })
  }

  reject(context: CommandContext, requisitionId: string, reason: string) {
    return this.decide(context, requisitionId, { kind: 'reject', reason })
  }

  cancel(context: CommandContext, requisitionId: string, reason: string) {
    return this.decide(context, requisitionId, { kind: 'cancel', reason })
  }

  private decide(
    context: CommandContext,
    requisitionId: string,
    decision: Decision,
  ): Promise<Either<Failure, { status: string }>> {
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const requisition = await scope.requisitions.findForUpdate(requisitionId)
      if (!requisition) return left(new ResourceNotFoundError('requisition was not found'))
      const now = this.clock.now()
      const applied = apply(requisition, decision, context.actor, now)
      if (applied.isLeft()) return left(applied.value)
      await scope.requisitions.save(requisition)
      await audit(scope, context, {
        action: ACTIONS[decision.kind],
        subjectType: 'requisition',
        subjectId: requisitionId,
        occurredAt: now,
        details: 'reason' in decision ? { reason: decision.reason } : {},
      })
      return right({ status: requisition.status })
    })
  }
}

function apply(
  requisition: PurchaseRequisition,
  decision: Decision,
  actor: string,
  now: Date,
): Either<Failure, void> {
  switch (decision.kind) {
    case 'submit':
      return requisition.submit(actor, now)
    case 'approve':
      return requisition.approve(actor, now)
    case 'reject': {
      const reason = reasonOf(decision.reason)
      return reason.isLeft() ? left(reason.value) : requisition.reject(actor, reason.value, now)
    }
    default: {
      const reason = reasonOf(decision.reason)
      return reason.isLeft() ? left(reason.value) : requisition.cancel(reason.value, now)
    }
  }
}
