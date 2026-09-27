import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Quote, QuoteLine } from '@/domain/entities/quote'
import type { CommercialLineInput } from '@/domain/entities/sales-order'
import { SalesOrder } from '@/domain/entities/sales-order'
import { ServiceOrder } from '@/domain/entities/service-order'
import type { RequestedOrderLine } from '@/domain/events/sales-events'
import type { ItemKind } from '@/domain/repositories/sales-repositories'
import { discountShare } from '@/domain/services/service-billing'
import { BusinessDate, Money } from '@/domain/value-objects/sales-values'
import type { Clock } from '../ports/clock'
import type { SalesScope, SalesUnitOfWork } from '../ports/unit-of-work'
import { audit, type IdempotentContext, type Outcome, once } from './commands'
import { placeAndRecord } from './place-order'
import { recordOpened } from './service-orders'

/**
 * Turn an accepted offer into the documents that deliver it.
 *
 * Its goods become a sales order and its services a service order (ADR 0056), both made
 * binding at the prices the customer agreed to. Nothing is re-read from the catalogue,
 * because a price list that moved between the yes and the order is not a new agreement.
 * The quote records what it became, so one acceptance never becomes two commitments.
 *
 * Money follows the goods and the services: the discount is split in proportion to each
 * side, and freight is the goods'. A proposal with freight and nothing to carry is refused.
 */
export class ConvertQuoteUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    quoteId: string
    fulfillmentWarehouseId?: string | undefined
  }): Outcome<{ quoteId: string; orderId: string | null; serviceOrderId: string | null }> {
    const { context } = request
    return once(this.unitOfWork, context, 'quote.convert', request, async (scope) => {
      const quote = await scope.quotes.findById(request.quoteId)
      if (!quote) return left(new ResourceNotFoundError('quote was not found'))
      if (quote.status !== 'accepted')
        return left(new ConflictError('only an accepted quote becomes an order'))
      const kinds = await scope.catalogItems.kindsOf(quote.lines().map((line) => line.itemId))
      const now = this.clock.now()
      const drafted = splitProposal(quote, kinds, {
        tenantId: context.tenantId,
        actor: context.actor,
        warehouseId: request.fulfillmentWarehouseId,
        now,
      })
      if (drafted.isLeft()) return left(drafted.value)
      const { order, serviceOrder } = drafted.value
      const documents = {
        orderId: order?.id.toString() ?? null,
        serviceOrderId: serviceOrder?.id.toString() ?? null,
      }
      // Marked before anything is placed: the quote refuses a second conversion here, and
      // every write is in the one transaction, so none can happen without the others.
      const marked = quote.markConverted(documents, now)
      if (marked.isLeft()) return left(marked.value)
      await scope.quotes.save(quote)
      const recorded = await recordDocuments(scope, context, quote, drafted.value, now)
      if (recorded.isLeft()) return left(recorded.value)
      await audit(scope, context, {
        action: 'quote.converted',
        subjectType: 'quote',
        subjectId: quote.id.toString(),
        occurredAt: now,
        details: { ...documents, version: quote.version, total: quote.total().amount },
      })
      return right({ quoteId: quote.id.toString(), ...documents })
    })
  }
}

/** Place the sales order and open the service order a conversion made, in its transaction. */
async function recordDocuments(
  scope: SalesScope,
  context: IdempotentContext,
  quote: Quote,
  documents: { order: SalesOrder | null; serviceOrder: ServiceOrder | null },
  now: Date,
): Outcome<void> {
  if (documents.order) {
    const placed = await placeAndRecord(scope, context, documents.order, now, {
      customerId: quote.customerId,
      quoteId: quote.id.toString(),
    })
    if (placed.isLeft()) return left(placed.value)
  }
  if (documents.serviceOrder)
    await recordOpened(scope, context, documents.serviceOrder, now, {
      quoteId: quote.id.toString(),
    })
  return right(undefined)
}

/**
 * The documents an accepted proposal becomes: its goods as a sales order (which needs a
 * warehouse), its services as a service order, with the discount split between them by net.
 */
function splitProposal(
  quote: Quote,
  kinds: ReadonlyMap<string, ItemKind>,
  input: { tenantId: string; actor: string; warehouseId: string | undefined; now: Date },
): Either<
  InvalidInputError | ConflictError,
  { order: SalesOrder | null; serviceOrder: ServiceOrder | null }
> {
  const services = quote.lines().filter((line) => kinds.get(line.itemId) === 'service')
  const goods = quote.lines().filter((line) => kinds.get(line.itemId) !== 'service')
  const terms = quote.terms()
  if (goods.length === 0 && !terms.freight.isZero())
    return left(new ConflictError('freight belongs to goods, and this proposal has none to carry'))
  if (goods.length > 0 && !input.warehouseId)
    return left(
      new InvalidInputError(
        '/fulfillmentWarehouseId',
        'the goods of this proposal need a fulfilment warehouse',
      ),
    )
  const serviceDiscount = discountShare(terms.discount, quote.net(), netOf(services, quote))
  const issuedOn = BusinessDate.of(input.now)
  const order =
    goods.length > 0 && input.warehouseId
      ? SalesOrder.draft({
          tenantId: input.tenantId,
          customerId: quote.customerId,
          fulfillmentWarehouseId: input.warehouseId,
          quoteId: quote.id.toString(),
          terms: { ...terms, discount: terms.discount.minus(serviceDiscount) },
          issuedOn,
          lines: goods.map(requested),
          agreedLines: goods.map(agreed),
          now: input.now,
        })
      : right<InvalidInputError, null>(null)
  if (order.isLeft()) return left(order.value)
  const serviceOrder =
    services.length > 0
      ? ServiceOrder.open({
          tenantId: input.tenantId,
          customerId: quote.customerId,
          quoteId: quote.id.toString(),
          currency: quote.currency,
          lines: services,
          discount: serviceDiscount,
          paymentTerms: terms.paymentTerms,
          notes: terms.notes,
          scheduledFor: null,
          openedOn: issuedOn,
          createdBy: input.actor,
          now: input.now,
        })
      : right<InvalidInputError, null>(null)
  if (serviceOrder.isLeft()) return left(serviceOrder.value)
  return right({ order: order.value, serviceOrder: serviceOrder.value })
}

function requested(line: QuoteLine): RequestedOrderLine {
  return { lineId: line.lineId, itemId: line.itemId, quantity: line.quantity }
}

function agreed(line: QuoteLine): CommercialLineInput {
  return {
    lineId: line.lineId,
    itemId: line.itemId,
    description: line.description,
    unitPrice: line.unitPrice,
  }
}

function netOf(lines: readonly QuoteLine[], quote: { currency: Money['currency'] }): Money {
  return lines.reduce((sum, line) => sum.plus(line.lineTotal), Money.fromAmount(0n, quote.currency))
}
