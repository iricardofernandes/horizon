import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { type OrderRevision, PurchaseOrder } from '@/domain/entities/purchase-order'
import type { PurchaseRequisition } from '@/domain/entities/purchase-requisition'
import type { Supplier } from '@/domain/entities/supplier'
import type { SupplierQuotation } from '@/domain/entities/supplier-quotation'
import type { Charges, PricedLineInput } from '@/domain/services/pricing'
import type {
  BusinessDate,
  Currency,
  Memo,
  PartyName,
  PaymentTerms,
} from '@/domain/value-objects/procurement-values'
import type { Clock } from '../ports/clock'
import type { ProcurementScope, ProcurementUnitOfWork } from '../ports/unit-of-work'
import {
  audit,
  type CommandContext,
  type Failure,
  type IdempotentContext,
  type Outcome,
  once,
} from './commands'
import {
  type ChargesInput,
  chargesOf,
  currencyOf,
  dateOf,
  memoOf,
  type PricedInput,
  paymentTermsOf,
  pricedLinesOf,
  reasonOf,
} from './inputs'

export interface OrderInput {
  readonly supplierId: string
  readonly warehouseId: string
  readonly requisitionId?: string | undefined
  readonly currency: string
  readonly lines: readonly PricedInput[]
  readonly charges?: ChargesInput | undefined
  readonly paymentTermDays?: readonly number[] | undefined
  readonly issuedOn: string
  readonly expectedOn: string
  readonly notes?: string | undefined
}

interface DraftValues {
  readonly currency: Currency
  readonly lines: readonly PricedLineInput[]
  readonly charges: Charges
  readonly paymentTerms: PaymentTerms
  readonly issuedOn: BusinessDate
  readonly expectedOn: BusinessDate
  readonly notes: Memo | null
}

/** Write an order by hand: this supplier, these goods, this money, these dates. */
export class DraftOrderUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    order: OrderInput
  }): Outcome<{ id: string; total: string }> {
    const { context, order } = request
    return once(this.unitOfWork, context, 'order.draft', order, async (scope) => {
      const values = await parseDraft(scope, order)
      if (values.isLeft()) return left(values.value)
      const supplier = await scope.suppliers.findById(order.supplierId)
      if (!supplier) return left(new ResourceNotFoundError('supplier was not found'))
      if (!supplier.isActive()) return left(new ConflictError('this supplier is not active'))
      const answered = await answerable(scope, order.requisitionId ?? null)
      if (answered.isLeft()) return left(answered.value)
      return draft(scope, context, {
        supplier: { supplierId: order.supplierId, name: supplier.name },
        requisitionId: order.requisitionId ?? null,
        quotationId: null,
        warehouseId: order.warehouseId,
        values: values.value,
        now: this.clock.now(),
      })
    })
  }
}

/**
 * Write the order the selected quotation implies.
 *
 * Everything is copied from the quotation — the prices, the charges, the payment terms,
 * the words on each line — rather than referenced, because from here on the order is the
 * document, and what the supplier offered last week must not move under it.
 */
export class DraftOrderFromQuotationUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    quotationId: string
    issuedOn: string
    expectedOn?: string | undefined
    notes?: string | undefined
  }): Outcome<{ id: string; total: string }> {
    const { context } = request
    const issuedOn = dateOf(request.issuedOn, '/issuedOn')
    if (issuedOn.isLeft()) return left(issuedOn.value)
    const notes = memoOf(request.notes)
    if (notes.isLeft()) return left(notes.value)
    return once(
      this.unitOfWork,
      context,
      'order.draft-from-quotation',
      { quotationId: request.quotationId, issuedOn: request.issuedOn },
      async (scope) => {
        const orderable = await orderableQuotation(scope, request.quotationId, issuedOn.value)
        if (orderable.isLeft()) return left(orderable.value)
        const { quotation, requisition, supplier } = orderable.value
        const expectedOn =
          request.expectedOn === undefined
            ? right<InvalidInputError, BusinessDate>(
                issuedOn.value.plusDays(quotation.leadTimeDays),
              )
            : dateOf(request.expectedOn, '/expectedOn')
        if (expectedOn.isLeft()) return left(expectedOn.value)
        return draft(scope, context, {
          supplier: { supplierId: quotation.supplierId, name: supplier.name },
          requisitionId: quotation.requisitionId,
          quotationId: request.quotationId,
          warehouseId: requisition.warehouseId,
          values: {
            currency: quotation.currency,
            lines: quotation.lines(),
            charges: quotation.charges,
            paymentTerms: quotation.paymentTerms,
            issuedOn: issuedOn.value,
            expectedOn: expectedOn.value,
            notes: notes.value,
          },
          now: this.clock.now(),
        })
      },
    )
  }
}

export class ReviseOrderUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    orderId: string
    order: Omit<OrderInput, 'supplierId' | 'warehouseId' | 'requisitionId' | 'issuedOn'>
  }): Promise<Either<Failure, { total: string }>> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const order = await scope.orders.findForUpdate(request.orderId)
      if (!order) return left(new ResourceNotFoundError('purchase order was not found'))
      if (request.order.currency !== order.currency.value)
        return left(new ConflictError('an order does not change currency; write another'))
      const values = await parseTerms(scope, request.order, order.currency)
      if (values.isLeft()) return left(values.value)
      const now = this.clock.now()
      const revised = order.revise(values.value, now)
      if (revised.isLeft()) return left(revised.value)
      await scope.orders.save(order)
      await audit(scope, context, {
        action: 'order.revised',
        subjectType: 'order',
        subjectId: request.orderId,
        occurredAt: now,
        details: { total: order.total().amount.toString(), currency: order.currency.value },
      })
      return right({ total: order.total().amount.toString() })
    })
  }
}

type Decision =
  | { readonly kind: 'place' }
  | { readonly kind: 'approve' }
  | { readonly kind: 'reject'; readonly reason: string }
  | { readonly kind: 'cancel'; readonly reason: string }

const ACTIONS = {
  place: 'order.placed',
  approve: 'order.approved',
  reject: 'order.rejected',
  cancel: 'order.cancelled',
} as const

/**
 * Committing an order, and undoing that.
 *
 * Placing asks the workspace's threshold whether a second person has to look. Under it the
 * order is committed on the spot and records that nobody was asked; at or above it the
 * order waits, and whoever placed it cannot be the one who approves it.
 */
export class DecideOrderUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  place(context: CommandContext, orderId: string) {
    return this.decide(context, orderId, { kind: 'place' })
  }

  approve(context: CommandContext, orderId: string) {
    return this.decide(context, orderId, { kind: 'approve' })
  }

  reject(context: CommandContext, orderId: string, reason: string) {
    return this.decide(context, orderId, { kind: 'reject', reason })
  }

  cancel(context: CommandContext, orderId: string, reason: string) {
    return this.decide(context, orderId, { kind: 'cancel', reason })
  }

  private decide(
    context: CommandContext,
    orderId: string,
    decision: Decision,
  ): Promise<Either<Failure, { status: string; approvalState: string }>> {
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const order = await scope.orders.findForUpdate(orderId)
      if (!order) return left(new ResourceNotFoundError('purchase order was not found'))
      const now = this.clock.now()
      const applied = await apply(scope, order, decision, context.actor, now)
      if (applied.isLeft()) return left(applied.value)
      if (order.status === 'approved') {
        const answered = await answerRequisition(scope, order, now)
        if (answered.isLeft()) return left(answered.value)
      }
      await scope.orders.save(order)
      await audit(scope, context, {
        action: ACTIONS[decision.kind],
        subjectType: 'order',
        subjectId: orderId,
        occurredAt: now,
        details: {
          total: order.total().amount.toString(),
          currency: order.currency.value,
          ...('reason' in decision ? { reason: decision.reason } : {}),
        },
      })
      return right({ status: order.status, approvalState: order.approvalState })
    })
  }
}

/** At or above the threshold an order waits for a second person; below it, it does not. */
export async function approvalRequired(
  scope: ProcurementScope,
  order: PurchaseOrder,
): Promise<boolean> {
  const policy = await scope.policies.find(order.currency.value)
  return policy === null || order.total().amount >= policy.threshold
}

async function apply(
  scope: ProcurementScope,
  order: PurchaseOrder,
  decision: Decision,
  actor: string,
  now: Date,
): Promise<Either<Failure, void>> {
  switch (decision.kind) {
    case 'place':
      return order.place(actor, now, { approvalRequired: await approvalRequired(scope, order) })
    case 'approve':
      return order.approve(actor, now)
    case 'reject': {
      const reason = reasonOf(decision.reason)
      return reason.isLeft() ? left(reason.value) : order.reject(actor, reason.value, now)
    }
    default: {
      const reason = reasonOf(decision.reason)
      return reason.isLeft() ? left(reason.value) : order.cancel(reason.value, now)
    }
  }
}

/** One requisition becomes one order; approving the order is what closes the requisition. */
async function answerRequisition(
  scope: ProcurementScope,
  order: PurchaseOrder,
  now: Date,
): Promise<Either<Failure, void>> {
  const requisitionId = order.requisitionId
  if (!requisitionId) return right(undefined)
  const requisition = await scope.requisitions.findForUpdate(requisitionId)
  if (!requisition) return left(new ResourceNotFoundError('requisition was not found'))
  const ordered = requisition.markOrdered(order.id.toString(), now)
  if (ordered.isLeft()) return left(ordered.value)
  await scope.requisitions.save(requisition)
  return right(undefined)
}

/** The terms of an order, parsed against one currency: lines, charges, schedule and dates. */
async function parseTerms(
  scope: ProcurementScope,
  input: Omit<OrderInput, 'supplierId' | 'warehouseId' | 'requisitionId' | 'issuedOn'>,
  currency: Currency,
): Promise<Either<Failure, OrderRevision>> {
  const expectedOn = dateOf(input.expectedOn, '/expectedOn')
  if (expectedOn.isLeft()) return left(expectedOn.value)
  const notes = memoOf(input.notes)
  if (notes.isLeft()) return left(notes.value)
  const charges = chargesOf(input.charges, currency)
  if (charges.isLeft()) return left(charges.value)
  const paymentTerms = paymentTermsOf(input.paymentTermDays)
  if (paymentTerms.isLeft()) return left(paymentTerms.value)
  const lines = await pricedLinesOf(scope, input.lines, currency)
  if (lines.isLeft()) return left(lines.value)
  return right({
    lines: lines.value,
    charges: charges.value,
    paymentTerms: paymentTerms.value,
    expectedOn: expectedOn.value,
    notes: notes.value,
  })
}

/** The three records an order written from a quotation copies from, or why it cannot be. */
async function orderableQuotation(
  scope: ProcurementScope,
  quotationId: string,
  issuedOn: BusinessDate,
): Promise<
  Either<
    Failure,
    { quotation: SupplierQuotation; requisition: PurchaseRequisition; supplier: Supplier }
  >
> {
  const quotation = await scope.quotations.findById(quotationId)
  if (!quotation) return left(new ResourceNotFoundError('quotation was not found'))
  if (quotation.status !== 'selected')
    return left(new ConflictError('select the quotation before ordering from it'))
  if (!quotation.isValidOn(issuedOn))
    return left(new ConflictError('this quotation had expired by the order date'))
  const answered = await answerable(scope, quotation.requisitionId)
  if (answered.isLeft()) return left(answered.value)
  const requisition = await scope.requisitions.findById(quotation.requisitionId)
  if (!requisition) return left(new ResourceNotFoundError('requisition was not found'))
  const supplier = await scope.suppliers.findById(quotation.supplierId)
  if (!supplier) return left(new ResourceNotFoundError('supplier was not found'))
  return right({ quotation, requisition, supplier })
}

/** A requisition may be answered once, and only once it has been approved. */
async function answerable(
  scope: ProcurementScope,
  requisitionId: string | null,
): Promise<Either<Failure, void>> {
  if (!requisitionId) return right(undefined)
  const requisition = await scope.requisitions.findById(requisitionId)
  if (!requisition) return left(new ResourceNotFoundError('requisition was not found'))
  if (requisition.status === 'ordered')
    return left(new ConflictError('this requisition has already been turned into an order'))
  if (requisition.status !== 'approved')
    return left(new ConflictError('approve the requisition before ordering against it'))
  return right(undefined)
}

async function parseDraft(
  scope: ProcurementScope,
  order: OrderInput,
): Promise<Either<Failure, DraftValues>> {
  const currency = currencyOf(order.currency)
  if (currency.isLeft()) return left(currency.value)
  const issuedOn = dateOf(order.issuedOn, '/issuedOn')
  if (issuedOn.isLeft()) return left(issuedOn.value)
  const terms = await parseTerms(scope, order, currency.value)
  if (terms.isLeft()) return left(terms.value)
  return right({ ...terms.value, currency: currency.value, issuedOn: issuedOn.value })
}

async function draft(
  scope: ProcurementScope,
  context: CommandContext,
  input: {
    supplier: { supplierId: string; name: PartyName }
    requisitionId: string | null
    quotationId: string | null
    warehouseId: string
    values: DraftValues
    now: Date
  },
): Promise<Either<Failure, { id: string; total: string }>> {
  const drafted = PurchaseOrder.draft({
    tenantId: scope.tenantId,
    supplier: input.supplier,
    requisitionId: input.requisitionId,
    quotationId: input.quotationId,
    warehouseId: input.warehouseId,
    currency: input.values.currency,
    lines: input.values.lines,
    charges: input.values.charges,
    paymentTerms: input.values.paymentTerms,
    issuedOn: input.values.issuedOn,
    expectedOn: input.values.expectedOn,
    notes: input.values.notes,
    now: input.now,
  })
  if (drafted.isLeft()) return left(drafted.value)
  await scope.orders.create(drafted.value)
  await audit(scope, context, {
    action: 'order.drafted',
    subjectType: 'order',
    subjectId: drafted.value.id.toString(),
    occurredAt: input.now,
    details: {
      supplierId: input.supplier.supplierId,
      requisitionId: input.requisitionId,
      quotationId: input.quotationId,
      total: drafted.value.total().amount.toString(),
      currency: input.values.currency.value,
    },
  })
  return right({
    id: drafted.value.id.toString(),
    total: drafted.value.total().amount.toString(),
  })
}
