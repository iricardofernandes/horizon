import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { moneyPayload, ProcurementEvent, quantityPayload } from '../events/procurement-events'
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
  Memo,
  Money,
  PartyName,
  PaymentTerms,
  Reason,
} from '../value-objects/procurement-values'

export const ORDER_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'cancelled'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

export const APPROVAL_STATES = ['none', 'pending', 'approved', 'rejected', 'not-required'] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]

export interface OrderApproval {
  readonly state: ApprovalState
  readonly requestedBy: string | null
  readonly requestedAt: Date | null
  readonly decidedBy: string | null
  readonly decidedAt: Date | null
  readonly reason: Reason | null
}

export const NO_APPROVAL: OrderApproval = Object.freeze({
  state: 'none',
  requestedBy: null,
  requestedAt: null,
  decidedBy: null,
  decidedAt: null,
  reason: null,
})

/** What the supplier was called on the day, kept so a rename never rewrites an order. */
export interface SupplierSnapshot {
  readonly supplierId: string
  readonly name: PartyName
}

interface OrderProps {
  tenantId: string
  supplier: SupplierSnapshot
  requisitionId: string | null
  quotationId: string | null
  warehouseId: string
  currency: Currency
  lines: readonly PricedLine[]
  charges: Charges
  paymentTerms: PaymentTerms
  issuedOn: BusinessDate
  expectedOn: BusinessDate
  notes: Memo | null
  status: OrderStatus
  approval: OrderApproval
  closure: Reason | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface OrderInput {
  readonly tenantId: string
  readonly supplier: SupplierSnapshot
  readonly requisitionId: string | null
  readonly quotationId: string | null
  readonly warehouseId: string
  readonly currency: Currency
  readonly lines: readonly PricedLineInput[]
  readonly charges: Charges
  readonly paymentTerms: PaymentTerms
  readonly issuedOn: BusinessDate
  readonly expectedOn: BusinessDate
  readonly notes: Memo | null
  readonly now: Date
}

export interface OrderRevision {
  readonly lines: readonly PricedLineInput[]
  readonly charges: Charges
  readonly paymentTerms: PaymentTerms
  readonly expectedOn: BusinessDate
  readonly notes: Memo | null
}

/**
 * The company's commitment to buy: this supplier, these goods, this money, these dates.
 *
 * Everything it says is its own copy — the supplier's name, each line's description and
 * price, the tax and freight, the payment terms. Nothing is read back from the catalogue
 * or the registry at display time, because an order is a document somebody agreed to and
 * a later price change must not rewrite what was agreed.
 *
 * A draft is a working document. Placing it either commits it outright or sends it for
 * approval, depending on what the workspace decided is worth a second person's attention;
 * from approval onward it is frozen, and a change of mind is a cancellation, not an edit.
 */
export class PurchaseOrder extends AggregateRoot<OrderProps> {
  static draft(input: OrderInput, id?: UniqueEntityID): Either<InvalidInputError, PurchaseOrder> {
    if (input.expectedOn.isBefore(input.issuedOn))
      return left(
        new InvalidInputError(
          '/expectedOn',
          'delivery cannot be expected before the order is issued',
        ),
      )
    const lines = priceLines(input.lines, input.charges, input.currency)
    if (lines.isLeft()) return left(lines.value)
    return right(
      new PurchaseOrder(
        {
          tenantId: input.tenantId,
          supplier: input.supplier,
          requisitionId: input.requisitionId,
          quotationId: input.quotationId,
          warehouseId: input.warehouseId,
          currency: input.currency,
          lines: lines.value,
          charges: input.charges,
          paymentTerms: input.paymentTerms,
          issuedOn: input.issuedOn,
          expectedOn: input.expectedOn,
          notes: input.notes,
          status: 'draft',
          approval: NO_APPROVAL,
          closure: null,
          version: 0,
          createdAt: input.now,
          updatedAt: input.now,
        },
        id,
      ),
    )
  }

  static rehydrate(props: OrderProps, id: UniqueEntityID): PurchaseOrder {
    return new PurchaseOrder(props, id)
  }

  get tenantId(): string {
    return this.props.tenantId
  }

  get status(): OrderStatus {
    return this.props.status
  }

  get approvalState(): ApprovalState {
    return this.props.approval.state
  }

  get supplierId(): string {
    return this.props.supplier.supplierId
  }

  get requisitionId(): string | null {
    return this.props.requisitionId
  }

  get currency(): Currency {
    return this.props.currency
  }

  get warehouseId(): string {
    return this.props.warehouseId
  }

  lines(): readonly PricedLine[] {
    return this.props.lines
  }

  total(): Money {
    return totalOf(this.props.lines, this.props.charges, this.props.currency)
  }

  /** The payment schedule this order would raise, dated from the day it was issued. */
  schedule(): readonly { readonly dueOn: BusinessDate; readonly amount: Money }[] {
    return this.props.paymentTerms.scheduleOf(this.total(), this.props.issuedOn)
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  revise(change: OrderRevision, now: Date): Either<InvalidInputError | ConflictError, void> {
    if (this.props.status !== 'draft')
      return left(
        new ConflictError('only a draft order can be revised; cancel it and write another'),
      )
    if (change.expectedOn.isBefore(this.props.issuedOn))
      return left(
        new InvalidInputError(
          '/expectedOn',
          'delivery cannot be expected before the order is issued',
        ),
      )
    const lines = priceLines(change.lines, change.charges, this.props.currency)
    if (lines.isLeft()) return left(lines.value)
    this.props.lines = lines.value
    this.props.charges = change.charges
    this.props.paymentTerms = change.paymentTerms
    this.props.expectedOn = change.expectedOn
    this.props.notes = change.notes
    this.advance(now)
    return right(undefined)
  }

  /**
   * Commit the order, or ask someone else to.
   *
   * `approvalRequired` is the workspace policy's verdict on this order's value. One that
   * needs a second person waits for them; one that does not is committed here and now and
   * records that nobody was asked, so an audit can tell an exemption from an oversight.
   */
  place(
    actor: string,
    now: Date,
    policy: { readonly approvalRequired: boolean },
  ): Either<ConflictError, void> {
    if (this.props.status !== 'draft')
      return left(new ConflictError(`a ${this.props.status} order cannot be placed`))
    this.props.approval = policy.approvalRequired
      ? { ...NO_APPROVAL, state: 'pending', requestedBy: actor, requestedAt: now }
      : { ...NO_APPROVAL, state: 'not-required' }
    this.props.status = policy.approvalRequired ? 'pending' : 'approved'
    this.advance(now)
    this.addDomainEvent(
      this.event('procurement.order.placed', now, {
        placedBy: actor,
        approvalRequired: policy.approvalRequired,
        ...this.commercialPayload(),
      }),
    )
    if (!policy.approvalRequired) this.addDomainEvent(this.approvedEvent(actor, now))
    return right(undefined)
  }

  /** Four eyes: whoever placed the order cannot be the one who approves it. */
  approve(actor: string, now: Date): Either<ConflictError, void> {
    const decidable = this.decidable(actor)
    if (decidable.isLeft()) return decidable
    this.props.approval = {
      ...this.props.approval,
      state: 'approved',
      decidedBy: actor,
      decidedAt: now,
    }
    this.props.status = 'approved'
    this.advance(now)
    this.addDomainEvent(this.approvedEvent(actor, now))
    return right(undefined)
  }

  reject(actor: string, reason: Reason, now: Date): Either<ConflictError, void> {
    const decidable = this.decidable(actor)
    if (decidable.isLeft()) return decidable
    this.props.approval = {
      ...this.props.approval,
      state: 'rejected',
      decidedBy: actor,
      decidedAt: now,
      reason,
    }
    this.props.status = 'rejected'
    this.advance(now)
    this.addDomainEvent(
      this.event('procurement.order.rejected', now, { rejectedBy: actor, reason: reason.value }),
    )
    return right(undefined)
  }

  cancel(reason: Reason, now: Date): Either<ConflictError, void> {
    if (this.props.status === 'cancelled' || this.props.status === 'rejected')
      return left(new ConflictError(`this order is already ${this.props.status}`))
    const wasApproved = this.props.status === 'approved'
    this.props.status = 'cancelled'
    this.props.closure = reason
    this.advance(now)
    this.addDomainEvent(
      this.event('procurement.order.cancelled', now, { reason: reason.value, wasApproved }),
    )
    return right(undefined)
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    supplierId: string
    supplierName: string
    requisitionId: string | null
    quotationId: string | null
    warehouseId: string
    currency: string
    tax: string
    freight: string
    otherCharges: string
    discount: string
    total: string
    paymentTermDays: readonly number[]
    issuedOn: string
    expectedOn: string
    notes: string | null
    status: OrderStatus
    approvalState: ApprovalState
    approvalRequestedBy: string | null
    approvalRequestedAt: Date | null
    approvalDecidedBy: string | null
    approvalDecidedAt: Date | null
    approvalReason: string | null
    closureReason: string | null
    version: number
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
      supplierId: this.props.supplier.supplierId,
      supplierName: this.props.supplier.name.value,
      requisitionId: this.props.requisitionId,
      quotationId: this.props.quotationId,
      warehouseId: this.props.warehouseId,
      currency: this.props.currency.value,
      tax: this.props.charges.tax.amount.toString(),
      freight: this.props.charges.freight.amount.toString(),
      otherCharges: this.props.charges.otherCharges.amount.toString(),
      discount: this.props.charges.discount.amount.toString(),
      total: this.total().amount.toString(),
      paymentTermDays: this.props.paymentTerms.days,
      issuedOn: this.props.issuedOn.value,
      expectedOn: this.props.expectedOn.value,
      notes: this.props.notes?.value ?? null,
      status: this.props.status,
      approvalState: this.props.approval.state,
      approvalRequestedBy: this.props.approval.requestedBy,
      approvalRequestedAt: this.props.approval.requestedAt,
      approvalDecidedBy: this.props.approval.decidedBy,
      approvalDecidedAt: this.props.approval.decidedAt,
      approvalReason: this.props.approval.reason?.value ?? null,
      closureReason: this.props.closure?.value ?? null,
      version: this.props.version,
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

  private decidable(actor: string): Either<ConflictError, void> {
    if (this.props.status !== 'pending' || this.props.approval.state !== 'pending')
      return left(new ConflictError('there is no pending approval to decide'))
    if (this.props.approval.requestedBy === actor)
      return left(new ConflictError('the person who placed the order cannot approve it'))
    return right(undefined)
  }

  /**
   * Everything a consumer needs to act on the order without asking Procurement anything:
   * what is owed and when, where the goods are going, and what is on each line.
   */
  private commercialPayload(): Readonly<Record<string, unknown>> {
    return {
      supplierId: this.props.supplier.supplierId,
      supplierName: this.props.supplier.name.value,
      requisitionId: this.props.requisitionId,
      warehouseId: this.props.warehouseId,
      issuedOn: this.props.issuedOn.value,
      expectedOn: this.props.expectedOn.value,
      total: moneyPayload(this.total()),
      lines: this.props.lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        description: line.description.value,
        quantity: quantityPayload(line.quantity),
        unitPrice: moneyPayload(line.unitPrice),
        lineTotal: moneyPayload(line.lineTotal),
      })),
    }
  }

  private approvedEvent(actor: string, now: Date): ProcurementEvent {
    return this.event('procurement.order.approved', now, {
      approvedBy: actor,
      approvalRequired: this.props.approval.state !== 'not-required',
      installments: this.schedule().map((installment, index) => ({
        number: index + 1,
        dueOn: installment.dueOn.value,
        amount: moneyPayload(installment.amount),
      })),
      ...this.commercialPayload(),
    })
  }

  private event(
    type: string,
    now: Date,
    payload: Readonly<Record<string, unknown>>,
  ): ProcurementEvent {
    return new ProcurementEvent(type, this.id, this.props.tenantId, now, {
      orderId: this.id.toString(),
      orderVersion: this.props.version,
      ...payload,
    })
  }

  private advance(now: Date): void {
    this.props.version += 1
    this.props.updatedAt = now
  }
}
