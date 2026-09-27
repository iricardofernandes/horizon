import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { QuoteLine, QuoteTerms } from '@/domain/entities/quote'
import { ServiceOrder } from '@/domain/entities/service-order'
import type { ItemKind } from '@/domain/repositories/sales-repositories'
import type { ShippedLine } from '@/domain/services/fulfilment'
import { BusinessDate, Quantity, Reason } from '@/domain/value-objects/sales-values'
import type { Clock } from '../ports/clock'
import type { SalesScope, SalesUnitOfWork } from '../ports/unit-of-work'
import {
  audit,
  type CommandContext,
  type Failure,
  type IdempotentContext,
  type Outcome,
  once,
} from './commands'
import { priceLines, type QuoteLineInput, type QuoteTermsInput, termsOf } from './manage-quotes'

/**
 * Services only. A good belongs on a sales order, and an item whose kind is not known yet
 * is treated as a good (ADR 0056), so it is refused here rather than guessed at.
 */
export function servicesOnly(
  lines: readonly { lineId: string; itemId: string }[],
  kinds: ReadonlyMap<string, ItemKind>,
): Either<ConflictError, void> {
  const goods = lines.filter((line) => kinds.get(line.itemId) !== 'service')
  if (goods.length === 0) return right(undefined)
  return left(
    new ConflictError(
      `a service order delivers service items only; goods go on a sales order (lines ${goods
        .map((line) => line.lineId)
        .join(', ')})`,
    ),
  )
}

/** Open a service order directly, priced from the Catalog projection like a proposal. */
export class OpenServiceOrderUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    customerId: string
    lines: readonly QuoteLineInput[]
    terms?: Pick<QuoteTermsInput, 'discount' | 'paymentTermDays' | 'notes'> | undefined
    scheduledFor?: string | undefined
  }): Outcome<{ serviceOrderId: string; total: string }> {
    const { context } = request
    return once(this.unitOfWork, context, 'service-order.open', request, async (scope) => {
      const priced = await pricedServices(scope, request)
      if (priced.isLeft()) return left(priced.value)
      const { lines, terms, scheduledFor } = priced.value
      const now = this.clock.now()
      const order = ServiceOrder.open({
        tenantId: context.tenantId,
        customerId: request.customerId,
        quoteId: null,
        currency: terms.discount.currency,
        lines,
        discount: terms.discount,
        paymentTerms: terms.paymentTerms,
        notes: terms.notes,
        scheduledFor,
        openedOn: BusinessDate.of(now),
        createdBy: context.actor,
        now,
      })
      if (order.isLeft()) return left(order.value)
      await recordOpened(scope, context, order.value, now, { quoteId: null })
      return right({
        serviceOrderId: order.value.id.toString(),
        total: order.value.total().amount.toString(),
      })
    })
  }
}

/** The lines of a directly opened service order, priced and checked, with its terms. */
async function pricedServices(
  scope: SalesScope,
  request: {
    customerId: string
    lines: readonly QuoteLineInput[]
    terms?: Pick<QuoteTermsInput, 'discount' | 'paymentTermDays' | 'notes'> | undefined
    scheduledFor?: string | undefined
  },
): Promise<
  Either<
    Failure,
    { lines: readonly QuoteLine[]; terms: QuoteTerms; scheduledFor: BusinessDate | null }
  >
> {
  const customer = await scope.customers.findById(request.customerId)
  if (!customer) return left(new ResourceNotFoundError('customer was not found'))
  if (!customer.isActive()) return left(new ConflictError('customer is no longer active'))
  const priced = await priceLines(scope, request.lines)
  if (priced.isLeft()) return left(priced.value)
  const kinds = await scope.catalogItems.kindsOf(priced.value.map((line) => line.itemId))
  const services = servicesOnly(priced.value, kinds)
  if (services.isLeft()) return left(services.value)
  const [first] = priced.value
  if (!first)
    return left(new InvalidInputError('/lines', 'a service order requires at least one line'))
  const terms = termsOf(request.terms, first.unitPrice.currency)
  if (terms.isLeft()) return left(terms.value)
  if (!request.scheduledFor)
    return right({ lines: priced.value, terms: terms.value, scheduledFor: null })
  const scheduledFor = BusinessDate.create(request.scheduledFor, '/scheduledFor')
  if (scheduledFor.isLeft()) return left(scheduledFor.value)
  return right({ lines: priced.value, terms: terms.value, scheduledFor: scheduledFor.value })
}

/** Persist a new service order and write down who opened it, and from what. */
export async function recordOpened(
  scope: SalesScope,
  context: CommandContext,
  order: ServiceOrder,
  now: Date,
  details: { quoteId: string | null },
): Promise<void> {
  await scope.serviceOrders.create(order)
  await audit(scope, context, {
    action: 'service-order.opened',
    subjectType: 'service-order',
    subjectId: order.id.toString(),
    occurredAt: now,
    details: {
      ...details,
      customerId: order.customerId,
      lines: order.lines().length,
      total: order.total().amount,
    },
  })
}

export interface DeliveryLineInput {
  readonly lineId: string
  readonly quantity: string
}

/**
 * Record work delivered to the customer. It is billed at once: the delivery is the fact
 * Financial raises the receivable from and Fiscal issues the NFS-e from.
 */
export class DeliverServiceUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    serviceOrderId: string
    lines?: readonly DeliveryLineInput[] | undefined
    performedOn?: string | undefined
  }): Outcome<{ deliveryId: string; value: string; status: string }> {
    const { context } = request
    return once(this.unitOfWork, context, 'service-order.deliver', request, async (scope) => {
      const order = await scope.serviceOrders.findById(request.serviceOrderId)
      if (!order) return left(new ResourceNotFoundError('service order was not found'))
      const lines: Either<InvalidInputError, readonly ShippedLine[] | 'outstanding'> = request.lines
        ? deliveryLinesOf(request.lines)
        : right('outstanding')
      if (lines.isLeft()) return left(lines.value)
      const now = this.clock.now()
      const today = BusinessDate.of(now)
      const performedOn: Either<InvalidInputError, BusinessDate> = request.performedOn
        ? BusinessDate.create(request.performedOn, '/performedOn')
        : right(today)
      if (performedOn.isLeft()) return left(performedOn.value)
      const delivered = order.deliver(
        {
          deliveryId: new UniqueEntityID().toString(),
          lines: lines.value,
          performedOn: performedOn.value,
          today,
          deliveredBy: context.actor,
          entryId: () => new UniqueEntityID().toString(),
        },
        now,
      )
      if (delivered.isLeft()) return left(delivered.value)
      await scope.serviceOrders.save(order)
      await audit(scope, context, {
        action: 'service-order.delivered',
        subjectType: 'service-order',
        subjectId: order.id.toString(),
        occurredAt: now,
        details: {
          deliveryId: delivered.value.id,
          performedOn: delivered.value.performedOn.value,
          value: delivered.value.value.amount,
          lines: delivered.value.entries.length,
          status: order.status,
        },
      })
      return right({
        deliveryId: delivered.value.id,
        value: delivered.value.value.amount.toString(),
        status: order.status,
      })
    })
  }
}

type Decision =
  | { readonly kind: 'start' }
  | { readonly kind: 'accept' }
  | { readonly kind: 'cancel'; readonly reason: string }
  | { readonly kind: 'cancel-delivery'; readonly deliveryId: string; readonly reason: string }

/**
 * Moving a service order along. None creates a document, so none takes an idempotency
 * key: repeating one is refused by the order's own state.
 */
export class DecideServiceOrderUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  start(context: CommandContext, serviceOrderId: string) {
    return this.decide(context, serviceOrderId, { kind: 'start' })
  }

  accept(context: CommandContext, serviceOrderId: string) {
    return this.decide(context, serviceOrderId, { kind: 'accept' })
  }

  cancel(context: CommandContext, serviceOrderId: string, reason: string) {
    return this.decide(context, serviceOrderId, { kind: 'cancel', reason })
  }

  cancelDelivery(
    context: CommandContext,
    serviceOrderId: string,
    deliveryId: string,
    reason: string,
  ) {
    return this.decide(context, serviceOrderId, { kind: 'cancel-delivery', deliveryId, reason })
  }

  private decide(
    context: CommandContext,
    serviceOrderId: string,
    decision: Decision,
  ): Outcome<{ status: string; version: number }> {
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const order = await scope.serviceOrders.findById(serviceOrderId)
      if (!order) return left(new ResourceNotFoundError('service order was not found'))
      const now = this.clock.now()
      const applied = apply(order, decision, context.actor, now)
      if (applied.isLeft()) return left(applied.value)
      await scope.serviceOrders.save(order)
      await audit(scope, context, {
        action: `service-order.${decision.kind === 'cancel-delivery' ? 'delivery-cancelled' : decision.kind}`,
        subjectType: 'service-order',
        subjectId: order.id.toString(),
        occurredAt: now,
        details: {
          status: order.status,
          ...('deliveryId' in decision ? { deliveryId: decision.deliveryId } : {}),
          ...('reason' in decision ? { reason: decision.reason } : {}),
        },
      })
      return right({ status: order.status, version: order.version })
    })
  }
}

function apply(
  order: ServiceOrder,
  decision: Decision,
  actor: string,
  now: Date,
): Either<InvalidInputError | ConflictError, void> {
  switch (decision.kind) {
    case 'start':
      return order.start(now)
    case 'accept':
      return order.accept(actor, now)
    case 'cancel': {
      const reason = Reason.create(decision.reason)
      return reason.isLeft() ? left(reason.value) : order.cancel(reason.value, now)
    }
    default: {
      const reason = Reason.create(decision.reason)
      if (reason.isLeft()) return left(reason.value)
      return order.cancelDelivery(
        {
          deliveryId: decision.deliveryId,
          reason: reason.value,
          cancelledOn: BusinessDate.of(now),
          cancelledBy: actor,
        },
        now,
      )
    }
  }
}

function deliveryLinesOf(
  inputs: readonly DeliveryLineInput[],
): Either<InvalidInputError, readonly ShippedLine[]> {
  const lines: ShippedLine[] = []
  for (const [index, input] of inputs.entries()) {
    const quantity = Quantity.create(input.quantity, `/lines/${index}/quantity`)
    if (quantity.isLeft()) return left(quantity.value)
    lines.push({ lineId: input.lineId, quantity: quantity.value })
  }
  return right(lines)
}
