import { left, right } from '@/core/either'
import { SalesOrder } from '@/domain/entities/sales-order'
import type { RequestedOrderLine } from '@/domain/events/sales-events'
import { BusinessDate, Currency, Quantity } from '@/domain/value-objects/sales-values'
import type { Clock } from '../ports/clock'
import type { SalesScope, SalesUnitOfWork } from '../ports/unit-of-work'
import { audit, type IdempotentContext, type Outcome, once } from './commands'
import { type QuoteTermsInput, termsOf } from './manage-quotes'

export class PlaceOrderUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    customerId: string
    fulfillmentWarehouseId: string
    currency?: string | undefined
    terms?: QuoteTermsInput | undefined
    lines: readonly { lineId: string; itemId: string; quantity: string }[]
  }): Outcome<{ orderId: string }> {
    const { context } = request
    const lines: RequestedOrderLine[] = []
    for (const [index, line] of request.lines.entries()) {
      const quantity = Quantity.create(line.quantity, `/lines/${index}/quantity`)
      if (quantity.isLeft()) return left(quantity.value)
      lines.push({ lineId: line.lineId, itemId: line.itemId, quantity: quantity.value })
    }
    // The terms carry money, so they need a currency before the lines have been priced.
    const currency = Currency.create(request.currency ?? 'BRL')
    if (currency.isLeft()) return left(currency.value)
    const terms = termsOf(request.terms, currency.value)
    if (terms.isLeft()) return left(terms.value)
    return once(this.unitOfWork, context, 'order.place', request, async (scope) => {
      const now = this.clock.now()
      const order = SalesOrder.draft({
        tenantId: context.tenantId,
        customerId: request.customerId,
        fulfillmentWarehouseId: request.fulfillmentWarehouseId,
        terms: terms.value,
        issuedOn: BusinessDate.of(now),
        lines,
        now,
      })
      if (order.isLeft()) return left(order.value)
      return placeAndRecord(scope, context, order.value, now, {
        customerId: request.customerId,
        quoteId: null,
      })
    })
  }
}

/** Place the drafted order, publish what it says, and write down who placed it. */
export async function placeAndRecord(
  scope: SalesScope,
  context: IdempotentContext,
  order: SalesOrder,
  now: Date,
  details: { customerId: string; quoteId: string | null },
): Outcome<{ orderId: string }> {
  const placed = order.place(now)
  if (placed.isLeft()) return left(placed.value)
  await scope.orders.create(order)
  for (const event of order.pullDomainEvents()) await scope.events.append(event)
  await audit(scope, context, {
    action: 'order.placed',
    subjectType: 'order',
    subjectId: order.id.toString(),
    occurredAt: now,
    details: {
      ...details,
      lines: order.requestedLines().length,
      paymentTermDays: [...order.terms().paymentTerms.days],
    },
  })
  return right({ orderId: order.id.toString() })
}
