import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import {
  type Charges,
  type PricedLine,
  type PricedLineInput,
  priceLines,
  totalOf,
} from '../services/pricing'
import type {
  BusinessDate,
  Currency,
  DocumentNumber,
  Memo,
  Money,
  PaymentTerms,
} from '../value-objects/procurement-values'

export const QUOTATION_STATUSES = ['received', 'selected', 'declined'] as const
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number]

const MAX_LEAD_TIME_DAYS = 365

interface QuotationProps {
  tenantId: string
  requisitionId: string
  supplierId: string
  reference: DocumentNumber
  quotedOn: BusinessDate
  validUntil: BusinessDate | null
  currency: Currency
  lines: readonly PricedLine[]
  charges: Charges
  paymentTerms: PaymentTerms
  leadTimeDays: number
  notes: Memo | null
  status: QuotationStatus
  recordedBy: string
  decidedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface QuotationInput {
  readonly tenantId: string
  readonly requisitionId: string
  readonly supplierId: string
  readonly reference: DocumentNumber
  readonly quotedOn: BusinessDate
  readonly validUntil: BusinessDate | null
  readonly currency: Currency
  readonly lines: readonly PricedLineInput[]
  readonly charges: Charges
  readonly paymentTerms: PaymentTerms
  readonly leadTimeDays: number
  readonly notes: Memo | null
  readonly recordedBy: string
  readonly now: Date
}

/**
 * What one supplier says it would charge to meet a requisition.
 *
 * It is a record of an answer, not a commitment: nothing here obliges anybody, which is
 * why a quotation is never revised — a supplier that changes its mind sends another one,
 * and both stay so the comparison shows what was actually offered and when.
 *
 * Selecting one is the buying decision; it says which answer the order will be written
 * from, and the order copies the numbers rather than pointing at them.
 */
export class SupplierQuotation extends AggregateRoot<QuotationProps> {
  static record(
    input: QuotationInput,
    id?: UniqueEntityID,
  ): Either<InvalidInputError, SupplierQuotation> {
    if (
      !Number.isInteger(input.leadTimeDays) ||
      input.leadTimeDays < 0 ||
      input.leadTimeDays > MAX_LEAD_TIME_DAYS
    )
      return left(
        new InvalidInputError(
          '/leadTimeDays',
          `must be a whole number of days, 0 to ${MAX_LEAD_TIME_DAYS}`,
        ),
      )
    if (input.validUntil?.isBefore(input.quotedOn))
      return left(
        new InvalidInputError('/validUntil', 'a quotation cannot expire before it was given'),
      )
    const lines = priceLines(input.lines, input.charges, input.currency)
    if (lines.isLeft()) return left(lines.value)
    return right(
      new SupplierQuotation(
        {
          tenantId: input.tenantId,
          requisitionId: input.requisitionId,
          supplierId: input.supplierId,
          reference: input.reference,
          quotedOn: input.quotedOn,
          validUntil: input.validUntil,
          currency: input.currency,
          lines: lines.value,
          charges: input.charges,
          paymentTerms: input.paymentTerms,
          leadTimeDays: input.leadTimeDays,
          notes: input.notes,
          status: 'received',
          recordedBy: input.recordedBy,
          decidedAt: null,
          createdAt: input.now,
          updatedAt: input.now,
        },
        id,
      ),
    )
  }

  static rehydrate(props: QuotationProps, id: UniqueEntityID): SupplierQuotation {
    return new SupplierQuotation(props, id)
  }

  get tenantId(): string {
    return this.props.tenantId
  }

  get requisitionId(): string {
    return this.props.requisitionId
  }

  get supplierId(): string {
    return this.props.supplierId
  }

  get status(): QuotationStatus {
    return this.props.status
  }

  get currency(): Currency {
    return this.props.currency
  }

  get paymentTerms(): PaymentTerms {
    return this.props.paymentTerms
  }

  get charges(): Charges {
    return this.props.charges
  }

  get leadTimeDays(): number {
    return this.props.leadTimeDays
  }

  lines(): readonly PricedLine[] {
    return this.props.lines
  }

  total(): Money {
    return totalOf(this.props.lines, this.props.charges, this.props.currency)
  }

  /** Is the quotation still worth ordering from on this date? */
  isValidOn(date: BusinessDate): boolean {
    return this.props.validUntil === null || !this.props.validUntil.isBefore(date)
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  select(now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'received')
      return left(new ConflictError(`a ${this.props.status} quotation cannot be selected`))
    this.props.status = 'selected'
    this.props.decidedAt = now
    this.props.updatedAt = now
    return right(undefined)
  }

  decline(now: Date): Either<ConflictError, void> {
    if (this.props.status === 'selected')
      return left(new ConflictError('a selected quotation cannot be declined'))
    if (this.props.status === 'declined') return right(undefined)
    this.props.status = 'declined'
    this.props.decidedAt = now
    this.props.updatedAt = now
    return right(undefined)
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    requisitionId: string
    supplierId: string
    reference: string
    quotedOn: string
    validUntil: string | null
    currency: string
    tax: string
    freight: string
    otherCharges: string
    discount: string
    total: string
    paymentTermDays: readonly number[]
    leadTimeDays: number
    notes: string | null
    status: QuotationStatus
    recordedBy: string
    decidedAt: Date | null
    createdAt: Date
    updatedAt: Date
    lines: readonly {
      lineId: string
      itemId: string
      description: string
      quantity: string
      unitPrice: string
      lineTotal: string
    }[]
  }> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      requisitionId: this.props.requisitionId,
      supplierId: this.props.supplierId,
      reference: this.props.reference.value,
      quotedOn: this.props.quotedOn.value,
      validUntil: this.props.validUntil?.value ?? null,
      currency: this.props.currency.value,
      tax: this.props.charges.tax.amount.toString(),
      freight: this.props.charges.freight.amount.toString(),
      otherCharges: this.props.charges.otherCharges.amount.toString(),
      discount: this.props.charges.discount.amount.toString(),
      total: this.total().amount.toString(),
      paymentTermDays: this.props.paymentTerms.days,
      leadTimeDays: this.props.leadTimeDays,
      notes: this.props.notes?.value ?? null,
      status: this.props.status,
      recordedBy: this.props.recordedBy,
      decidedAt: this.props.decidedAt,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
      lines: this.props.lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        description: line.description.value,
        quantity: line.quantity.toString(),
        unitPrice: line.unitPrice.amount.toString(),
        lineTotal: line.lineTotal.amount.toString(),
      })),
    })
  }
}
