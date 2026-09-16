import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { Title } from '@/domain/entities/title'
import type { Clock } from '../ports/clock'
import type { FinancialScope, FinancialUnitOfWork } from '../ports/unit-of-work'
import {
  type CommandContext,
  checkClassification,
  checkParty,
  checkPaymentMethod,
  type Failure,
  fingerprintOf,
  type IdempotentContext,
  reasonOf,
  type SettlementRequest,
  settlementOf,
  type TermsInput,
  termsOf,
} from './receivable-inputs'

const DIRECTION = 'receivable'

function audit(
  scope: FinancialScope,
  context: CommandContext,
  title: Title,
  action: string,
  occurredAt: Date,
  details: Record<string, unknown> = {},
) {
  return scope.audit.append({
    actor: context.actor,
    action,
    subjectType: 'title',
    subjectId: title.id.toString(),
    occurredAt,
    requestId: context.requestId,
    details,
  })
}

/** Load a receivable of this workspace, locked for the transaction. */
async function receivable(
  scope: FinancialScope,
  titleId: string,
): Promise<Either<ResourceNotFoundError, Title>> {
  const title = await scope.titles.findForUpdate(titleId)
  if (!title || title.direction !== DIRECTION)
    return left(new ResourceNotFoundError('receivable was not found'))
  return right(title)
}

export class DraftReceivableUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    terms: TermsInput
  }): Promise<Either<Failure, { id: string }>> {
    const terms = termsOf(request.terms)
    if (terms.isLeft()) return left(terms.value)
    const { context } = request
    return this.unitOfWork.once(
      context.tenantId,
      {
        idempotencyKey: context.idempotencyKey,
        command: 'receivable.draft',
        fingerprint: fingerprintOf('receivable.draft', request.terms),
      },
      async (scope): Promise<Either<Failure, { id: string }>> => {
        const party = await checkParty(scope, DIRECTION, terms.value.partyId)
        if (party.isLeft()) return left(party.value)
        const classification = await checkClassification(scope, DIRECTION, terms.value)
        if (classification.isLeft()) return left(classification.value)
        const now = this.clock.now()
        const title = Title.draft({
          tenantId: context.tenantId,
          direction: DIRECTION,
          origin: { type: 'manual' },
          terms: terms.value,
          now,
        })
        if (title.isLeft()) return left(title.value)
        await scope.titles.create(title.value)
        await audit(scope, context, title.value, 'receivable.drafted', now, {
          documentNumber: terms.value.documentNumber.value,
          total: title.value.total().amount,
          currency: terms.value.currency.value,
        })
        return right({ id: title.value.id.toString() })
      },
    )
  }
}

/** A draft is a working document: its terms are replaced wholesale. */
export class ReviseReceivableUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: CommandContext
    titleId: string
    terms: TermsInput
  }): Promise<Either<Failure, void>> {
    const terms = termsOf(request.terms)
    if (terms.isLeft()) return left(terms.value)
    return this.unitOfWork.inTenant(request.context.tenantId, async (scope) => {
      const title = await receivable(scope, request.titleId)
      if (title.isLeft()) return left(title.value)
      if (title.value.origin.type === 'manual' || title.value.partyId !== terms.value.partyId) {
        const party = await checkParty(scope, DIRECTION, terms.value.partyId)
        if (party.isLeft()) return left(party.value)
      }
      const classification = await checkClassification(scope, DIRECTION, terms.value)
      if (classification.isLeft()) return left(classification.value)
      const now = this.clock.now()
      const revised = title.value.revise(terms.value, now)
      if (revised.isLeft()) return left(revised.value)
      await scope.titles.save(title.value)
      await audit(scope, request.context, title.value, 'receivable.revised', now, {
        total: title.value.total().amount,
      })
      return right(undefined)
    })
  }
}

export class PostReceivableUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    titleId: string
  }): Promise<Either<Failure, { id: string; status: string }>> {
    const { context } = request
    return this.unitOfWork.once(
      context.tenantId,
      {
        idempotencyKey: context.idempotencyKey,
        command: 'receivable.post',
        fingerprint: fingerprintOf('receivable.post', { titleId: request.titleId }),
      },
      async (scope): Promise<Either<Failure, { id: string; status: string }>> => {
        const title = await receivable(scope, request.titleId)
        if (title.isLeft()) return left(title.value)
        const party = await scope.parties.find(title.value.partyId)
        if (party?.erased) return left(new ConflictError('the party was erased'))
        const classification = await checkClassification(scope, DIRECTION, title.value)
        if (classification.isLeft()) return left(classification.value)
        const now = this.clock.now()
        const posted = title.value.post(now)
        if (posted.isLeft()) return left(posted.value)
        await scope.titles.save(title.value)
        await audit(scope, context, title.value, 'receivable.posted', now, {
          total: title.value.total().amount,
        })
        return right({ id: request.titleId, status: title.value.status })
      },
    )
  }
}

export class CancelReceivableUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: CommandContext
    titleId: string
    reason: string
  }): Promise<Either<Failure, void>> {
    const reason = reasonOf(request.reason)
    if (reason.isLeft()) return left(reason.value)
    return this.unitOfWork.inTenant(request.context.tenantId, async (scope) => {
      const title = await receivable(scope, request.titleId)
      if (title.isLeft()) return left(title.value)
      const now = this.clock.now()
      const cancelled = title.value.cancel(reason.value, now)
      if (cancelled.isLeft()) return left(cancelled.value)
      await scope.titles.save(title.value)
      await audit(scope, request.context, title.value, 'receivable.cancelled', now, {
        reason: reason.value.value,
      })
      return right(undefined)
    })
  }
}

export class ReverseReceivableUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    titleId: string
    reason: string
  }): Promise<Either<Failure, { id: string; status: string }>> {
    const reason = reasonOf(request.reason)
    if (reason.isLeft()) return left(reason.value)
    const { context } = request
    return this.unitOfWork.once(
      context.tenantId,
      {
        idempotencyKey: context.idempotencyKey,
        command: 'receivable.reverse',
        fingerprint: fingerprintOf('receivable.reverse', {
          titleId: request.titleId,
          reason: request.reason,
        }),
      },
      async (scope): Promise<Either<Failure, { id: string; status: string }>> => {
        const title = await receivable(scope, request.titleId)
        if (title.isLeft()) return left(title.value)
        const now = this.clock.now()
        const reversed = title.value.reverse(reason.value, now)
        if (reversed.isLeft()) return left(reversed.value)
        await scope.titles.save(title.value)
        await audit(scope, context, title.value, 'receivable.reversed', now, {
          reason: reason.value.value,
        })
        return right({ id: request.titleId, status: title.value.status })
      },
    )
  }
}

export class RecordSettlementUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    titleId: string
    settlement: SettlementRequest
  }): Promise<Either<Failure, { settlementId: string; outstanding: string }>> {
    const { context } = request
    return this.unitOfWork.once(
      context.tenantId,
      {
        idempotencyKey: context.idempotencyKey,
        command: 'receivable.settle',
        fingerprint: fingerprintOf('receivable.settle', {
          titleId: request.titleId,
          ...request.settlement,
        }),
      },
      async (scope): Promise<Either<Failure, { settlementId: string; outstanding: string }>> => {
        const title = await receivable(scope, request.titleId)
        if (title.isLeft()) return left(title.value)
        const input = settlementOf(request.settlement, title.value.currency)
        if (input.isLeft()) return left(input.value)
        const method = await checkPaymentMethod(scope, input.value.paymentMethodId)
        if (method.isLeft()) return left(method.value)
        const now = this.clock.now()
        const settlement = title.value.settle(input.value, now)
        if (settlement.isLeft()) return left(settlement.value)
        await scope.titles.save(title.value)
        await audit(scope, context, title.value, 'settlement.recorded', now, {
          settlementId: settlement.value.id,
          installmentNumber: settlement.value.installmentNumber,
          received: settlement.value.received.amount,
          discount: settlement.value.discount.amount,
          interest: settlement.value.interest.amount,
          penalty: settlement.value.penalty.amount,
        })
        return right({
          settlementId: settlement.value.id,
          outstanding: title.value.outstanding().amount.toString(),
        })
      },
    )
  }
}

export class ReverseSettlementUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    titleId: string
    settlementId: string
    reason: string
  }): Promise<Either<Failure, { outstanding: string }>> {
    const reason = reasonOf(request.reason)
    if (reason.isLeft()) return left(reason.value)
    const { context } = request
    return this.unitOfWork.once(
      context.tenantId,
      {
        idempotencyKey: context.idempotencyKey,
        command: 'settlement.reverse',
        fingerprint: fingerprintOf('settlement.reverse', {
          titleId: request.titleId,
          settlementId: request.settlementId,
          reason: request.reason,
        }),
      },
      async (scope): Promise<Either<Failure, { outstanding: string }>> => {
        const title = await receivable(scope, request.titleId)
        if (title.isLeft()) return left(title.value)
        const now = this.clock.now()
        const reversed = title.value.reverseSettlement(request.settlementId, reason.value, now)
        if (reversed.isLeft()) return left(reversed.value)
        await scope.titles.save(title.value)
        await audit(scope, context, title.value, 'settlement.reversed', now, {
          settlementId: request.settlementId,
          reason: reason.value.value,
        })
        return right({ outstanding: title.value.outstanding().amount.toString() })
      },
    )
  }
}
