import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { Quote, type QuoteLine } from '@/domain/entities/quote'
import { Money, Quantity } from '@/domain/value-objects/sales-values'
import type { Clock } from '../ports/clock'
import type { SalesScope, SalesUnitOfWork } from '../ports/unit-of-work'

type QuoteError = InvalidInputError | ResourceNotFoundError | ConflictError

export class CreateQuoteUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
    private readonly validityDays: number,
  ) {
    if (!Number.isSafeInteger(validityDays) || validityDays < 1)
      throw new RangeError('quote validity must be a positive number of days')
  }

  execute(request: {
    tenantId: string
    customerId: string
    lines: readonly { lineId: string; itemId: string; quantity: string }[]
  }): Promise<Either<QuoteError, { quoteId: string; expiresAt: Date }>> {
    return this.unitOfWork.inTenant(request.tenantId, (scope) => this.create(scope, request))
  }

  private async create(
    scope: SalesScope,
    request: {
      tenantId: string
      customerId: string
      lines: readonly { lineId: string; itemId: string; quantity: string }[]
    },
  ): Promise<Either<QuoteError, { quoteId: string; expiresAt: Date }>> {
    const customer = await scope.customers.findById(request.customerId)
    if (!customer) return left(new ResourceNotFoundError('customer was not found'))
    if (!customer.isActive()) return left(new ConflictError('customer is no longer active'))
    if (request.lines.length === 0)
      return left(new InvalidInputError('/lines', 'a quote requires at least one line'))
    const lines = await this.buildLines(scope, request.lines)
    if (lines.isLeft()) return left(lines.value)
    if (new Set(lines.value.map((line) => line.itemId)).size !== lines.value.length)
      return left(new InvalidInputError('/lines', 'item identifiers must be unique'))
    const total = this.totalOf(lines.value)
    if (total.isLeft()) return left(total.value)
    const now = this.clock.now()
    const expiresAt = new Date(now.getTime() + this.validityDays * 86_400_000)
    const quote = Quote.draft({
      tenantId: request.tenantId,
      customerId: request.customerId,
      lines: lines.value,
      total: total.value,
      expiresAt,
      now,
    })
    await scope.quotes.create(quote)
    return right({ quoteId: quote.id.toString(), expiresAt })
  }

  private async buildLines(
    scope: SalesScope,
    inputs: readonly { lineId: string; itemId: string; quantity: string }[],
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

  private totalOf(lines: readonly QuoteLine[]): Either<ConflictError, Money> {
    const [first] = lines
    if (!first) throw new Error('validated quote unexpectedly has no lines')
    let total = Money.fromAmount(0n, first.unitPrice.currency)
    for (const line of lines) {
      if (!line.unitPrice.currency.equals(total.currency))
        return left(new ConflictError('all quote lines must use one currency'))
      total = total.plus(line.lineTotal)
    }
    return right(total)
  }
}

export class AcceptQuoteUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    tenantId: string
    quoteId: string
  }): Promise<Either<ResourceNotFoundError | ConflictError, void>> {
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const quote = await scope.quotes.findById(request.quoteId)
      if (!quote) return left(new ResourceNotFoundError('quote was not found'))
      const accepted = quote.accept(this.clock.now())
      await scope.quotes.save(quote)
      if (accepted.isLeft()) return left(accepted.value)
      return right(undefined)
    })
  }
}
