import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { SupplierQuotation } from '@/domain/entities/supplier-quotation'
import type {
  BusinessDate,
  Currency,
  DocumentNumber,
  Memo,
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
  documentNumberOf,
  memoOf,
  type PricedInput,
  paymentTermsOf,
  pricedLinesOf,
} from './inputs'

export interface QuotationInput {
  readonly requisitionId: string
  readonly supplierId: string
  readonly reference: string
  readonly quotedOn: string
  readonly validUntil?: string | undefined
  readonly currency: string
  readonly lines: readonly PricedInput[]
  readonly charges?: ChargesInput | undefined
  readonly paymentTermDays?: readonly number[] | undefined
  readonly leadTimeDays: number
  readonly notes?: string | undefined
}

/**
 * Record what a supplier answered.
 *
 * A quotation is only accepted against a requisition that is still open to being answered,
 * and only from a supplier the registry knows: a comparison between one real offer and one
 * made up is not a comparison. Every line must be a line of the requisition, so the two
 * can actually be read side by side.
 */
export class RecordQuotationUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    quotation: QuotationInput
  }): Outcome<{ id: string; total: string }> {
    const { context, quotation } = request
    const parsed = parseHeader(quotation)
    if (parsed.isLeft()) return left(parsed.value)
    const header = parsed.value
    return once(this.unitOfWork, context, 'quotation.record', quotation, async (scope) => {
      const answerable = await answerableRequisition(scope, quotation)
      if (answerable.isLeft()) return left(answerable.value)
      const lines = await pricedLinesOf(scope, quotation.lines, header.currency)
      if (lines.isLeft()) return left(lines.value)
      const charges = chargesOf(quotation.charges, header.currency)
      if (charges.isLeft()) return left(charges.value)
      const now = this.clock.now()
      const recorded = SupplierQuotation.record({
        tenantId: context.tenantId,
        requisitionId: quotation.requisitionId,
        supplierId: quotation.supplierId,
        reference: header.reference,
        quotedOn: header.quotedOn,
        validUntil: header.validUntil,
        currency: header.currency,
        lines: lines.value,
        charges: charges.value,
        paymentTerms: header.paymentTerms,
        leadTimeDays: quotation.leadTimeDays,
        notes: header.notes,
        recordedBy: context.actor,
        now,
      })
      if (recorded.isLeft()) return left(recorded.value)
      await scope.quotations.create(recorded.value)
      await audit(scope, context, {
        action: 'quotation.recorded',
        subjectType: 'quotation',
        subjectId: recorded.value.id.toString(),
        occurredAt: now,
        details: {
          requisitionId: quotation.requisitionId,
          supplierId: quotation.supplierId,
          total: recorded.value.total().amount.toString(),
          currency: header.currency.value,
        },
      })
      return right({
        id: recorded.value.id.toString(),
        total: recorded.value.total().amount.toString(),
      })
    })
  }
}

/**
 * Choose the answer the order will be written from.
 *
 * Choosing one declines the rest in the same transaction, so a requisition never has two
 * selected quotations and the comparison always shows one decision rather than a history
 * of them.
 */
export class SelectQuotationUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    quotationId: string
    reason?: string | undefined
  }): Promise<Either<Failure, { declined: number }>> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const quotation = await scope.quotations.findForUpdate(request.quotationId)
      if (!quotation) return left(new ResourceNotFoundError('quotation was not found'))
      const now = this.clock.now()
      const selected = quotation.select(now)
      if (selected.isLeft()) return left(selected.value)
      await scope.quotations.save(quotation)
      const siblings = await scope.quotations.listForRequisition(quotation.requisitionId)
      let declined = 0
      for (const sibling of siblings) {
        if (sibling.id.toString() === request.quotationId || sibling.status !== 'received') continue
        const refused = sibling.decline(now)
        if (refused.isLeft()) continue
        await scope.quotations.save(sibling)
        declined += 1
      }
      await audit(scope, context, {
        action: 'quotation.selected',
        subjectType: 'quotation',
        subjectId: request.quotationId,
        occurredAt: now,
        details: {
          requisitionId: quotation.requisitionId,
          declined,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        },
      })
      return right({ declined })
    })
  }
}

/** Set one offer aside without choosing another; the requisition stays open. */
export class DeclineQuotationUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    quotationId: string
  }): Promise<Either<Failure, void>> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const quotation = await scope.quotations.findForUpdate(request.quotationId)
      if (!quotation) return left(new ResourceNotFoundError('quotation was not found'))
      const now = this.clock.now()
      const declined = quotation.decline(now)
      if (declined.isLeft()) return left(declined.value)
      await scope.quotations.save(quotation)
      await audit(scope, context, {
        action: 'quotation.declined',
        subjectType: 'quotation',
        subjectId: request.quotationId,
        occurredAt: now,
        details: { requisitionId: quotation.requisitionId },
      })
      return right(undefined)
    })
  }
}

/**
 * May this supplier answer this requisition, with these lines?
 *
 * All three have to hold for the offer to be comparable with the others: the requisition
 * is still open, the supplier is one the registry vouches for, and every line priced is a
 * line that was actually asked for.
 */
async function answerableRequisition(
  scope: ProcurementScope,
  quotation: QuotationInput,
): Promise<Either<Failure, void>> {
  const requisition = await scope.requisitions.findById(quotation.requisitionId)
  if (!requisition) return left(new ResourceNotFoundError('requisition was not found'))
  if (requisition.status !== 'submitted' && requisition.status !== 'approved')
    return left(new ConflictError(`a ${requisition.status} requisition is not open to quotations`))
  const supplier = await scope.suppliers.findById(quotation.supplierId)
  if (!supplier) return left(new ResourceNotFoundError('supplier was not found'))
  if (!supplier.isActive()) return left(new ConflictError('this supplier is not active'))
  const unknown = quotation.lines.find((line) => !requisition.lineOf(line.lineId))
  if (unknown)
    return left(new ConflictError(`line ${unknown.lineId} is not a line of this requisition`))
  return right(undefined)
}

interface QuotationHeader {
  readonly currency: Currency
  readonly reference: DocumentNumber
  readonly quotedOn: BusinessDate
  readonly validUntil: BusinessDate | null
  readonly paymentTerms: PaymentTerms
  readonly notes: Memo | null
}

function parseHeader(quotation: QuotationInput): Either<InvalidInputError, QuotationHeader> {
  const currency = currencyOf(quotation.currency)
  if (currency.isLeft()) return left(currency.value)
  const reference = documentNumberOf(quotation.reference)
  if (reference.isLeft()) return left(reference.value)
  const quotedOn = dateOf(quotation.quotedOn, '/quotedOn')
  if (quotedOn.isLeft()) return left(quotedOn.value)
  const validUntil =
    quotation.validUntil === undefined
      ? right<InvalidInputError, BusinessDate | null>(null)
      : dateOf(quotation.validUntil, '/validUntil')
  if (validUntil.isLeft()) return left(validUntil.value)
  const paymentTerms = paymentTermsOf(quotation.paymentTermDays)
  if (paymentTerms.isLeft()) return left(paymentTerms.value)
  const notes = memoOf(quotation.notes)
  if (notes.isLeft()) return left(notes.value)
  return right({
    currency: currency.value,
    reference: reference.value,
    quotedOn: quotedOn.value,
    validUntil: validUntil.value,
    paymentTerms: paymentTerms.value,
    notes: notes.value,
  })
}
