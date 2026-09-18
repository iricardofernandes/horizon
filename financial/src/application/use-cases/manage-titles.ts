import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import {
  Title,
  type TitleDirection,
  type TitleStage,
  type TitleTerms,
} from '@/domain/entities/title'
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
} from './title-inputs'

type Outcome<T> = Promise<Either<Failure, T>>

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

/**
 * The shared shape of every title command: a direction, a unit of work and a clock. A
 * title of the other direction is not found, so `/receivables/:id` never reaches a payable.
 */
abstract class TitleCommand {
  constructor(
    protected readonly unitOfWork: FinancialUnitOfWork,
    protected readonly clock: Clock,
    protected readonly direction: TitleDirection,
  ) {}

  protected async load(
    scope: FinancialScope,
    titleId: string,
  ): Promise<Either<ResourceNotFoundError, Title>> {
    const title = await scope.titles.findForUpdate(titleId)
    if (!title || title.direction !== this.direction)
      return left(new ResourceNotFoundError(`${this.direction} was not found`))
    return right(title)
  }

  protected once<T>(
    context: IdempotentContext,
    command: string,
    request: unknown,
    work: (scope: FinancialScope) => Outcome<T>,
  ): Outcome<T> {
    const name = `${this.direction}.${command}`
    return this.unitOfWork.once(
      context.tenantId,
      {
        idempotencyKey: context.idempotencyKey,
        command: name,
        fingerprint: fingerprintOf(name, request),
      },
      work,
    )
  }
}

export class DraftTitleUseCase extends TitleCommand {
  async execute(request: {
    context: IdempotentContext
    terms: TermsInput
    /** A forecast is money expected rather than owed; it posts only once realised. */
    stage?: TitleStage
  }): Outcome<{ id: string }> {
    const terms = termsOf(request.terms)
    if (terms.isLeft()) return left(terms.value)
    const { context } = request
    const stage = request.stage ?? 'effective'
    return this.once(context, 'draft', { ...request.terms, stage }, async (scope) => {
      const party = await checkParty(scope, this.direction, terms.value.partyId)
      if (party.isLeft()) return left(party.value)
      const classification = await checkClassification(scope, this.direction, terms.value)
      if (classification.isLeft()) return left(classification.value)
      const now = this.clock.now()
      const title = Title.draft({
        tenantId: context.tenantId,
        direction: this.direction,
        origin: { type: 'manual' },
        terms: terms.value,
        stage,
        now,
      })
      if (title.isLeft()) return left(title.value)
      await scope.titles.create(title.value)
      await audit(scope, context, title.value, `${this.direction}.drafted`, now, {
        documentNumber: terms.value.documentNumber.value,
        total: title.value.total().amount,
        currency: terms.value.currency.value,
        stage,
      })
      return right({ id: title.value.id.toString() })
    })
  }
}

/**
 * Turn a forecast into an effective title.
 *
 * The same title changes stage rather than being closed and replaced, so the expected
 * money and the claim on the customer are never both counted at once. Terms may be given
 * when what was invoiced differs from what was ordered.
 */
export class RealiseForecastUseCase extends TitleCommand {
  async execute(request: {
    context: CommandContext
    titleId: string
    terms?: TermsInput | undefined
  }): Outcome<void> {
    let terms: TitleTerms | null = null
    if (request.terms) {
      const parsed = termsOf(request.terms)
      if (parsed.isLeft()) return left(parsed.value)
      terms = parsed.value
    }
    return this.unitOfWork.inTenant(request.context.tenantId, async (scope): Outcome<void> => {
      const title = await this.load(scope, request.titleId)
      if (title.isLeft()) return left(title.value)
      if (terms) {
        const party = await checkParty(scope, this.direction, terms.partyId)
        if (party.isLeft()) return left(party.value)
        const classification = await checkClassification(scope, this.direction, terms)
        if (classification.isLeft()) return left(classification.value)
      }
      const now = this.clock.now()
      const realised = title.value.realise(terms, now)
      if (realised.isLeft()) return left(realised.value)
      await scope.titles.save(title.value)
      await audit(scope, request.context, title.value, `${this.direction}.realised`, now, {
        total: title.value.total().amount,
        revised: terms !== null,
      })
      return right(undefined)
    })
  }
}

/** A draft is a working document: its terms are replaced wholesale. */
export class ReviseTitleUseCase extends TitleCommand {
  async execute(request: {
    context: CommandContext
    titleId: string
    terms: TermsInput
  }): Outcome<void> {
    const terms = termsOf(request.terms)
    if (terms.isLeft()) return left(terms.value)
    return this.unitOfWork.inTenant(request.context.tenantId, async (scope): Outcome<void> => {
      const title = await this.load(scope, request.titleId)
      if (title.isLeft()) return left(title.value)
      if (title.value.origin.type === 'manual' || title.value.partyId !== terms.value.partyId) {
        const party = await checkParty(scope, this.direction, terms.value.partyId)
        if (party.isLeft()) return left(party.value)
      }
      const classification = await checkClassification(scope, this.direction, terms.value)
      if (classification.isLeft()) return left(classification.value)
      const now = this.clock.now()
      const revised = title.value.revise(terms.value, now)
      if (revised.isLeft()) return left(revised.value)
      await scope.titles.save(title.value)
      await audit(scope, request.context, title.value, `${this.direction}.revised`, now, {
        total: title.value.total().amount,
      })
      return right(undefined)
    })
  }
}

export class PostTitleUseCase extends TitleCommand {
  execute(request: {
    context: IdempotentContext
    titleId: string
  }): Outcome<{ id: string; status: string }> {
    const { context } = request
    return this.once(context, 'post', { titleId: request.titleId }, async (scope) => {
      const title = await this.load(scope, request.titleId)
      if (title.isLeft()) return left(title.value)
      const party = await scope.parties.find(title.value.partyId)
      if (party?.erased) return left(new ConflictError('the party was erased'))
      const classification = await checkClassification(scope, this.direction, title.value)
      if (classification.isLeft()) return left(classification.value)
      const now = this.clock.now()
      const posted = title.value.post(now, {
        approvalRequired: await approvalRequired(scope, title.value),
      })
      if (posted.isLeft()) return left(posted.value)
      await scope.titles.save(title.value)
      await audit(scope, context, title.value, `${this.direction}.posted`, now, {
        total: title.value.total().amount,
      })
      return right({ id: request.titleId, status: title.value.status })
    })
  }
}

/** Receivables never wait for approval; payables do unless the policy exempts their size. */
async function approvalRequired(scope: FinancialScope, title: Title): Promise<boolean> {
  if (title.direction !== 'payable') return false
  const policy = await scope.approvalPolicies.find('payable', title.currency.value)
  return policy === null || title.total().amount >= policy.threshold
}

export class CancelTitleUseCase extends TitleCommand {
  async execute(request: {
    context: CommandContext
    titleId: string
    reason: string
  }): Outcome<void> {
    const reason = reasonOf(request.reason)
    if (reason.isLeft()) return left(reason.value)
    return this.unitOfWork.inTenant(request.context.tenantId, async (scope): Outcome<void> => {
      const title = await this.load(scope, request.titleId)
      if (title.isLeft()) return left(title.value)
      const now = this.clock.now()
      const cancelled = title.value.cancel(reason.value, now)
      if (cancelled.isLeft()) return left(cancelled.value)
      await scope.titles.save(title.value)
      await audit(scope, request.context, title.value, `${this.direction}.cancelled`, now, {
        reason: reason.value.value,
      })
      return right(undefined)
    })
  }
}

export class ReverseTitleUseCase extends TitleCommand {
  async execute(request: {
    context: IdempotentContext
    titleId: string
    reason: string
  }): Outcome<{ id: string; status: string }> {
    const reason = reasonOf(request.reason)
    if (reason.isLeft()) return left(reason.value)
    const { context } = request
    const fingerprint = { titleId: request.titleId, reason: request.reason }
    return this.once(context, 'reverse', fingerprint, async (scope) => {
      const title = await this.load(scope, request.titleId)
      if (title.isLeft()) return left(title.value)
      const now = this.clock.now()
      const reversed = title.value.reverse(reason.value, now)
      if (reversed.isLeft()) return left(reversed.value)
      await scope.titles.save(title.value)
      await audit(scope, context, title.value, `${this.direction}.reversed`, now, {
        reason: reason.value.value,
      })
      return right({ id: request.titleId, status: title.value.status })
    })
  }
}

export class RecordSettlementUseCase extends TitleCommand {
  execute(request: {
    context: IdempotentContext
    titleId: string
    settlement: SettlementRequest
  }): Outcome<{ settlementId: string; outstanding: string }> {
    const { context } = request
    const fingerprint = { titleId: request.titleId, ...request.settlement }
    return this.once(context, 'settle', fingerprint, async (scope) => {
      const title = await this.load(scope, request.titleId)
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
    })
  }
}

export class ReverseSettlementUseCase extends TitleCommand {
  async execute(request: {
    context: IdempotentContext
    titleId: string
    settlementId: string
    reason: string
  }): Outcome<{ outstanding: string }> {
    const reason = reasonOf(request.reason)
    if (reason.isLeft()) return left(reason.value)
    const { context } = request
    const fingerprint = {
      titleId: request.titleId,
      settlementId: request.settlementId,
      reason: request.reason,
    }
    return this.once(context, 'settlement.reverse', fingerprint, async (scope) => {
      const title = await this.load(scope, request.titleId)
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
    })
  }
}
