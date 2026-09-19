import { left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { CommercialLineInput } from '@/domain/entities/sales-order'
import { SalesOrder } from '@/domain/entities/sales-order'
import type { RequestedOrderLine } from '@/domain/events/sales-events'
import { BusinessDate } from '@/domain/value-objects/sales-values'
import type { Clock } from '../ports/clock'
import type { SalesUnitOfWork } from '../ports/unit-of-work'
import { audit, type IdempotentContext, type Outcome, once } from './commands'
import { placeAndRecord } from './place-order'

/**
 * Turn an accepted offer into the order that delivers it.
 *
 * The order is the quote made binding: the same lines, at the prices the customer agreed
 * to, under the terms that were negotiated. Nothing is re-read from the catalogue, because
 * a price list that moved between the yes and the order is not a new agreement — and the
 * quote records which order it became, so one acceptance can never become two commitments.
 */
export class ConvertQuoteUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    quoteId: string
    fulfillmentWarehouseId: string
  }): Outcome<{ orderId: string; quoteId: string }> {
    const { context } = request
    return once(this.unitOfWork, context, 'quote.convert', request, async (scope) => {
      const quote = await scope.quotes.findById(request.quoteId)
      if (!quote) return left(new ResourceNotFoundError('quote was not found'))
      if (quote.status !== 'accepted')
        return left(new ConflictError('only an accepted quote becomes an order'))
      const now = this.clock.now()
      const lines: RequestedOrderLine[] = quote
        .lines()
        .map((line) => ({ lineId: line.lineId, itemId: line.itemId, quantity: line.quantity }))
      const agreedLines: CommercialLineInput[] = quote.lines().map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        description: line.description,
        unitPrice: line.unitPrice,
      }))
      const order = SalesOrder.draft({
        tenantId: context.tenantId,
        customerId: quote.customerId,
        fulfillmentWarehouseId: request.fulfillmentWarehouseId,
        quoteId: quote.id.toString(),
        terms: quote.terms(),
        issuedOn: BusinessDate.of(now),
        lines,
        agreedLines,
        now,
      })
      if (order.isLeft()) return left(order.value)
      // Marked before the order is placed: the quote refuses a second conversion here,
      // and both writes are in the one transaction, so neither can happen without the other.
      const marked = quote.markOrdered(order.value.id.toString(), now)
      if (marked.isLeft()) return left(marked.value)
      await scope.quotes.save(quote)
      const placed = await placeAndRecord(scope, context, order.value, now, {
        customerId: quote.customerId,
        quoteId: quote.id.toString(),
      })
      if (placed.isLeft()) return left(placed.value)
      await audit(scope, context, {
        action: 'quote.converted',
        subjectType: 'quote',
        subjectId: quote.id.toString(),
        occurredAt: now,
        details: {
          orderId: placed.value.orderId,
          version: quote.version,
          total: quote.total().amount,
        },
      })
      return right({ orderId: placed.value.orderId, quoteId: quote.id.toString() })
    })
  }
}
