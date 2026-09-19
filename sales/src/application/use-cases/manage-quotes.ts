import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { Quote, type QuoteLine, type QuoteTerms } from '@/domain/entities/quote'
import {
  CarrierName,
  type Currency,
  Money,
  PaymentTerms,
  Quantity,
  Reason,
} from '@/domain/value-objects/sales-values'
import type { Clock } from '../ports/clock'
import type { SalesScope, SalesUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext, type IdempotentContext, type Outcome, once } from './commands'

type QuoteError = InvalidInputError | ResourceNotFoundError | ConflictError

export interface QuoteLineInput {
  readonly lineId: string
  readonly itemId: string
  readonly quantity: string
}

export interface QuoteTermsInput {
  readonly sellerId?: string | undefined
  readonly discount?: string | undefined
  readonly freight?: string | undefined
  readonly carrier?: string | undefined
  readonly paymentTermDays?: readonly number[] | undefined
  readonly notes?: string | undefined
}

export interface QuoteRequest {
  readonly lines: readonly QuoteLineInput[]
  readonly terms?: QuoteTermsInput | undefined
}

/**
 * How deep a discount a workspace lets a seller give without asking anybody.
 *
 * Expressed against the goods, in basis points, because a discount is judged as a share of
 * what is being sold rather than as an amount: ten percent off is the same decision on a
 * small order as on a large one.
 */
export const DEFAULT_DISCOUNT_ALLOWANCE_BASIS_POINTS = 1_000

export class WriteQuoteUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
    private readonly validityDays: number,
  ) {
    if (!Number.isSafeInteger(validityDays) || validityDays < 1)
      throw new RangeError('quote validity must be a positive number of days')
  }

  execute(request: {
    context: IdempotentContext
    customerId: string
    quote: QuoteRequest
  }): Outcome<{ quoteId: string; expiresAt: Date; total: string }> {
    const { context } = request
    return once(this.unitOfWork, context, 'quote.write', request.quote, async (scope) => {
      const customer = await scope.customers.findById(request.customerId)
      if (!customer) return left(new ResourceNotFoundError('customer was not found'))
      if (!customer.isActive()) return left(new ConflictError('customer is no longer active'))
      const priced = await priceLines(scope, request.quote.lines)
      if (priced.isLeft()) return left(priced.value)
      const [first] = priced.value
      if (!first) return left(new InvalidInputError('/lines', 'a quote requires at least one line'))
      const currency = first.unitPrice.currency
      const terms = termsOf(request.quote.terms, currency)
      if (terms.isLeft()) return left(terms.value)
      const now = this.clock.now()
      const quote = Quote.draft({
        tenantId: context.tenantId,
        customerId: request.customerId,
        currency,
        lines: priced.value,
        terms: terms.value,
        expiresAt: new Date(now.getTime() + this.validityDays * 86_400_000),
        now,
      })
      if (quote.isLeft()) return left(quote.value)
      await scope.quotes.create(quote.value)
      await audit(scope, context, {
        action: 'quote.written',
        subjectType: 'quote',
        subjectId: quote.value.id.toString(),
        occurredAt: now,
        details: {
          customerId: request.customerId,
          lines: request.quote.lines.length,
          total: quote.value.total().amount,
          discount: terms.value.discount.amount,
        },
      })
      return right({
        quoteId: quote.value.id.toString(),
        expiresAt: quote.value.expiresAt,
        total: quote.value.total().amount.toString(),
      })
    })
  }
}

/**
 * Negotiate: change a draft in place, or answer a sent offer with a new version of it.
 *
 * A sent quote is what the customer was shown, so it is never rewritten. The new version
 * supersedes it in the same transaction, which is what keeps exactly one version of an
 * offer current at any moment.
 */
export class ReviseQuoteUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
    private readonly validityDays: number,
  ) {}

  execute(request: {
    context: IdempotentContext
    quoteId: string
    quote: QuoteRequest
  }): Outcome<{ quoteId: string; version: number }> {
    const { context } = request
    return once(this.unitOfWork, context, 'quote.revise', request, async (scope) => {
      const quote = await scope.quotes.findById(request.quoteId)
      if (!quote) return left(new ResourceNotFoundError('quote was not found'))
      const priced = await priceLines(scope, request.quote.lines)
      if (priced.isLeft()) return left(priced.value)
      const terms = termsOf(request.quote.terms, quote.currency)
      if (terms.isLeft()) return left(terms.value)
      const now = this.clock.now()
      const expiresAt = new Date(now.getTime() + this.validityDays * 86_400_000)
      const change = { lines: priced.value, terms: terms.value, expiresAt }

      if (quote.status === 'draft') {
        const revised = quote.revise(change, now)
        if (revised.isLeft()) return left(revised.value)
        await scope.quotes.save(quote)
        await audit(scope, context, {
          action: 'quote.revised',
          subjectType: 'quote',
          subjectId: quote.id.toString(),
          occurredAt: now,
          details: { version: quote.version, total: quote.total().amount },
        })
        return right({ quoteId: quote.id.toString(), version: quote.version })
      }

      const next = quote.nextVersion(change, now, new UniqueEntityID())
      if (next.isLeft()) return left(next.value)
      const superseded = quote.supersede(next.value.id.toString(), now)
      if (superseded.isLeft()) return left(superseded.value)
      await scope.quotes.save(quote)
      await scope.quotes.create(next.value)
      await audit(scope, context, {
        action: 'quote.versioned',
        subjectType: 'quote',
        subjectId: next.value.id.toString(),
        occurredAt: now,
        details: {
          supersedes: quote.id.toString(),
          version: next.value.version,
          total: next.value.total().amount,
        },
      })
      return right({ quoteId: next.value.id.toString(), version: next.value.version })
    })
  }
}

type Decision =
  | { readonly kind: 'send' }
  | { readonly kind: 'approve' }
  | { readonly kind: 'refuse'; readonly reason: string }
  | { readonly kind: 'accept' }
  | { readonly kind: 'decline'; readonly reason: string }
  | { readonly kind: 'expire' }

/**
 * Moving a quote along: sending it, deciding a discount, and what the customer answered.
 *
 * None of these creates a document, so none takes an idempotency key: repeating one is
 * refused by the quote's own state, which is a better answer than a remembered receipt.
 */
export class DecideQuoteUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
    private readonly allowanceBasisPoints = DEFAULT_DISCOUNT_ALLOWANCE_BASIS_POINTS,
  ) {}

  send(context: CommandContext, quoteId: string) {
    return this.decide(context, quoteId, { kind: 'send' })
  }

  approve(context: CommandContext, quoteId: string) {
    return this.decide(context, quoteId, { kind: 'approve' })
  }

  refuse(context: CommandContext, quoteId: string, reason: string) {
    return this.decide(context, quoteId, { kind: 'refuse', reason })
  }

  accept(context: CommandContext, quoteId: string) {
    return this.decide(context, quoteId, { kind: 'accept' })
  }

  decline(context: CommandContext, quoteId: string, reason: string) {
    return this.decide(context, quoteId, { kind: 'decline', reason })
  }

  expire(context: CommandContext, quoteId: string) {
    return this.decide(context, quoteId, { kind: 'expire' })
  }

  private decide(
    context: CommandContext,
    quoteId: string,
    decision: Decision,
  ): Outcome<{ status: string; approvalState: string }> {
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const quote = await scope.quotes.findById(quoteId)
      if (!quote) return left(new ResourceNotFoundError('quote was not found'))
      const now = this.clock.now()
      const applied = apply(quote, decision, context.actor, now, this.allowanceBasisPoints)
      if (applied.isLeft()) {
        // An offer found expired is recorded as expired, even when the command it was
        // refusing is what discovered it.
        await scope.quotes.save(quote)
        if (quote.status === 'expired')
          await audit(scope, context, {
            action: 'quote.expired',
            subjectType: 'quote',
            subjectId: quote.id.toString(),
            occurredAt: now,
            details: { discoveredBy: decision.kind, version: quote.version },
          })
        return left(applied.value)
      }
      await scope.quotes.save(quote)
      await audit(scope, context, {
        action: `quote.${decision.kind}`,
        subjectType: 'quote',
        subjectId: quote.id.toString(),
        occurredAt: now,
        details: {
          version: quote.version,
          status: quote.status,
          approvalState: quote.approvalState,
          ...('reason' in decision ? { reason: decision.reason } : {}),
        },
      })
      return right({ status: quote.status, approvalState: quote.approvalState })
    })
  }
}

function apply(
  quote: Quote,
  decision: Decision,
  actor: string,
  now: Date,
  allowance: number,
): Either<QuoteError, void> {
  switch (decision.kind) {
    case 'send':
      return quote.send(actor, now, {
        approvalRequired: quote.discountBasisPoints() > allowance,
      })
    case 'approve':
      return quote.approve(actor, now)
    case 'refuse': {
      const reason = Reason.create(decision.reason)
      return reason.isLeft() ? left(reason.value) : quote.refuseApproval(actor, reason.value, now)
    }
    case 'accept':
      return quote.accept(now)
    case 'decline': {
      const reason = Reason.create(decision.reason)
      return reason.isLeft() ? left(reason.value) : quote.decline(reason.value, now)
    }
    default:
      return quote.expire(now)
  }
}

/** The lines, priced from the catalogue projection as it stands today. */
async function priceLines(
  scope: SalesScope,
  inputs: readonly QuoteLineInput[],
): Promise<Either<QuoteError, readonly QuoteLine[]>> {
  const lines: QuoteLine[] = []
  for (const [index, input] of inputs.entries()) {
    const quantity = Quantity.create(input.quantity, `/lines/${index}/quantity`)
    if (quantity.isLeft()) return left(quantity.value)
    if (quantity.value.isZero())
      return left(new InvalidInputError(`/lines/${index}/quantity`, 'must be positive'))
    const item = await scope.catalogItems.findById(input.itemId)
    if (!item) return left(new ResourceNotFoundError('catalog item projection was not found'))
    if (!item.active) return left(new ConflictError('catalog item is inactive'))
    lines.push({
      lineId: input.lineId,
      itemId: input.itemId,
      quantity: quantity.value,
      description: item.description,
      unitPrice: item.unitPrice,
      lineTotal: item.unitPrice.multiply(quantity.value),
    })
  }
  return right(lines)
}

export function termsOf(
  input: QuoteTermsInput | undefined,
  currency: Currency,
): Either<InvalidInputError, QuoteTerms> {
  const zero = Money.fromAmount(0n, currency)
  const discount: Either<InvalidInputError, Money> = input?.discount
    ? Money.create(input.discount, currency)
    : right(zero)
  if (discount.isLeft()) return left(discount.value)
  const freight: Either<InvalidInputError, Money> = input?.freight
    ? Money.create(input.freight, currency)
    : right(zero)
  if (freight.isLeft()) return left(freight.value)
  const carrier: Either<InvalidInputError, CarrierName | null> = input?.carrier
    ? CarrierName.create(input.carrier)
    : right(null)
  if (carrier.isLeft()) return left(carrier.value)
  const paymentTerms: Either<InvalidInputError, PaymentTerms> = input?.paymentTermDays
    ? PaymentTerms.create(input.paymentTermDays)
    : right(PaymentTerms.immediate())
  if (paymentTerms.isLeft()) return left(paymentTerms.value)
  return right({
    sellerId: input?.sellerId ?? null,
    discount: discount.value,
    freight: freight.value,
    carrier: carrier.value,
    paymentTerms: paymentTerms.value,
    notes: input?.notes ?? null,
  })
}
