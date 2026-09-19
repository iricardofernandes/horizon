import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { moneyPayload, ProcurementEvent, quantityPayload } from '../events/procurement-events'
import {
  type Charges,
  netOf,
  type PricedLine,
  type PricedLineInput,
  priceLines,
  totalOf,
} from '../services/pricing'
import {
  type Installment,
  netOfReceived,
  priceReceipt,
  quantityReceived,
  type ReceiptPlan,
  type ReceivedLine,
  scheduleFrom,
  shareOf,
} from '../services/receiving'
import type {
  BusinessDate,
  Currency,
  Memo,
  PartyName,
  PaymentTerms,
  Quantity,
  Reason,
} from '../value-objects/procurement-values'
import { Money } from '../value-objects/procurement-values'

export const ORDER_STATUSES = [
  'draft',
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'received',
  'closed',
] as const
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
  /** What has arrived so far, per line, cumulative across every receipt. */
  received: readonly ReceivedLine[]
  receipts: number
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
          received: [],
          receipts: 0,
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
    if (CLOSED_STATUSES.has(this.props.status))
      return left(new ConflictError(`this order is already ${this.props.status}`))
    if (this.props.receipts > 0)
      return left(
        new ConflictError('goods have already arrived against this order; close it instead'),
      )
    const wasApproved = this.props.status === 'approved'
    this.props.status = 'cancelled'
    this.props.closure = reason
    this.advance(now)
    this.addDomainEvent(
      this.event('procurement.order.cancelled', now, { reason: reason.value, wasApproved }),
    )
    return right(undefined)
  }

  /** How much of a line is still expected; zero once it has all arrived. */
  outstandingOf(lineId: string): Quantity | null {
    const ordered = this.props.lines.find((line) => line.lineId === lineId)
    if (!ordered) return null
    const received = quantityReceived(this.props.received, lineId)
    if (!received) return ordered.quantity
    return received.isLessThan(ordered.quantity) ? ordered.quantity.minus(received) : null
  }

  receivedSoFar(): readonly ReceivedLine[] {
    return this.props.received
  }

  /**
   * Take delivery of part or all of the order.
   *
   * What the goods make owed is their share of the order's total, because tax, freight and
   * the discount were agreed for the order as a whole. More may arrive than was ordered,
   * and sometimes that is fine — but never silently: it takes a reason, and the reason is
   * kept, because a delivery nobody agreed to is a cost nobody agreed to.
   */
  receive(
    delivery: {
      readonly receivedOn: BusinessDate
      readonly lines: readonly ReceivedLine[]
      readonly override: Reason | null
    },
    now: Date,
  ): Either<InvalidInputError | ConflictError, ReceiptPlan> {
    if (this.props.status !== 'approved')
      return left(new ConflictError(`a ${this.props.status} order is not receiving goods`))
    if (delivery.receivedOn.isBefore(this.props.issuedOn))
      return left(
        new InvalidInputError('/receivedOn', 'goods cannot arrive before the order was issued'),
      )
    const checked = this.checkDelivery(delivery.lines, delivery.override !== null)
    if (checked.isLeft()) return left(checked.value)

    const before = netOfReceived(this.props.lines, this.props.received, this.props.currency)
    const received = merge(this.props.received, delivery.lines)
    const after = netOfReceived(this.props.lines, received, this.props.currency)
    const total = this.total()
    const ordered = netOf(this.props.lines, this.props.currency)
    const carried = shareOf(total, ordered, before)
    const value = shareOf(total, ordered, after).minus(carried)
    const remaining = ordered.isLessThan(after)
      ? Money.zero(this.props.currency)
      : total.minus(carried).minus(value)
    const complete = this.props.lines.every((line) => {
      const arrived = quantityReceived(received, line.lineId)
      return arrived !== undefined && !arrived.isLessThan(line.quantity)
    })

    this.props.received = received
    this.props.receipts += 1
    if (complete) this.props.status = 'received'
    this.advance(now)

    return right({
      lines: priceReceipt(this.props.lines, delivery.lines),
      value,
      installments: scheduleFrom(this.props.paymentTerms, value, delivery.receivedOn),
      remaining,
      remainingInstallments: scheduleFrom(this.props.paymentTerms, remaining, this.props.issuedOn),
      complete,
      overReceipt: delivery.override !== null,
    })
  }

  /**
   * Undo a delivery: the goods go back, and what they made owed goes with them.
   *
   * What the order still expects goes back up by the same amount, because a rejected
   * delivery is a delivery the supplier still owes.
   */
  unreceive(
    lines: readonly ReceivedLine[],
    now: Date,
  ): Either<ConflictError, { remaining: Money; remainingInstallments: readonly Installment[] }> {
    if (this.props.receipts === 0)
      return left(new ConflictError('nothing has arrived against this order'))
    const returned = subtract(this.props.received, lines)
    if (returned.isLeft()) return left(returned.value)
    this.props.received = returned.value
    this.props.receipts -= 1
    if (this.props.status === 'received') this.props.status = 'approved'
    this.advance(now)
    const remaining = this.stillCommitted()
    return right({
      remaining,
      remainingInstallments: scheduleFrom(this.props.paymentTerms, remaining, this.props.issuedOn),
    })
  }

  /** What the order committed to and has not received, at the order's own prices. */
  private stillCommitted(): Money {
    const total = this.total()
    const ordered = netOf(this.props.lines, this.props.currency)
    const arrived = netOfReceived(this.props.lines, this.props.received, this.props.currency)
    if (ordered.isLessThan(arrived)) return Money.zero(this.props.currency)
    return total.minus(shareOf(total, ordered, arrived))
  }

  /**
   * Stop expecting anything more against this order.
   *
   * A complete order closes itself; one that will never be completed is closed by a person,
   * with a reason, and whatever is still committed stops being expected.
   */
  close(reason: Reason, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'approved' && this.props.status !== 'received')
      return left(new ConflictError(`a ${this.props.status} order has nothing left to close`))
    const complete = this.props.status === 'received'
    this.props.status = 'closed'
    this.props.closure = reason
    this.advance(now)
    this.addDomainEvent(
      this.event('procurement.order.closed', now, {
        reason: reason.value,
        complete,
        receipts: this.props.receipts,
      }),
    )
    return right(undefined)
  }

  /** The event a receipt publishes, so both stories it starts read from one payload. */
  receiptEvent(
    receiptId: string,
    delivery: { readonly receivedOn: BusinessDate; readonly notes: Memo | null },
    plan: ReceiptPlan,
    actor: string,
    now: Date,
  ): void {
    this.addDomainEvent(
      this.event('procurement.receipt.recorded', now, {
        receiptId,
        receivedBy: actor,
        receivedOn: delivery.receivedOn.value,
        supplierId: this.props.supplier.supplierId,
        supplierName: this.props.supplier.name.value,
        warehouseId: this.props.warehouseId,
        notes: delivery.notes?.value ?? null,
        overReceipt: plan.overReceipt,
        complete: plan.complete,
        value: moneyPayload(plan.value),
        installments: plan.installments.map((installment) => ({
          number: installment.number,
          dueOn: installment.dueOn.value,
          amount: moneyPayload(installment.amount),
        })),
        remaining: moneyPayload(plan.remaining),
        remainingInstallments: plan.remainingInstallments.map((installment) => ({
          number: installment.number,
          dueOn: installment.dueOn.value,
          amount: moneyPayload(installment.amount),
        })),
        lines: plan.lines.map((line) => ({
          lineId: line.lineId,
          itemId: line.itemId,
          description: line.description,
          quantity: quantityPayload(line.quantity),
          unitPrice: moneyPayload(line.unitPrice),
          lineTotal: moneyPayload(line.lineTotal),
        })),
      }),
    )
  }

  returnEvent(
    receipt: { readonly id: string; readonly lines: readonly ReceiptLineRecord[] },
    outstanding: {
      readonly remaining: Money
      readonly remainingInstallments: readonly Installment[]
    },
    reason: Reason,
    actor: string,
    now: Date,
  ): void {
    this.addDomainEvent(
      this.event('procurement.receipt.returned', now, {
        receiptId: receipt.id,
        returnedBy: actor,
        reason: reason.value,
        warehouseId: this.props.warehouseId,
        remaining: moneyPayload(outstanding.remaining),
        remainingInstallments: outstanding.remainingInstallments.map((installment) => ({
          number: installment.number,
          dueOn: installment.dueOn.value,
          amount: moneyPayload(installment.amount),
        })),
        lines: receipt.lines.map((line) => ({
          lineId: line.lineId,
          itemId: line.itemId,
          quantity: line.quantity,
        })),
      }),
    )
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
    receipts: number
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
      received: string
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
      receipts: this.props.receipts,
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
        received: quantityReceived(this.props.received, line.lineId)?.toString() ?? '0',
      })),
    })
  }

  /**
   * Is this a delivery of this order, and does it fit what was ordered?
   *
   * Receiving more than was ordered is allowed, because it happens and refusing to record
   * it would leave the stock and the invoice unexplained — but only deliberately, which is
   * what the override is.
   */
  private checkDelivery(
    lines: readonly ReceivedLine[],
    overridden: boolean,
  ): Either<InvalidInputError | ConflictError, void> {
    if (lines.length === 0)
      return left(new InvalidInputError('/lines', 'a receipt requires at least one line'))
    if (new Set(lines.map((line) => line.lineId)).size !== lines.length)
      return left(new InvalidInputError('/lines', 'receive each line once'))
    for (const line of lines) {
      if (line.quantity.isZero())
        return left(
          new InvalidInputError('/lines/quantity', 'received quantities must be positive'),
        )
      const ordered = this.props.lines.find((candidate) => candidate.lineId === line.lineId)
      if (!ordered)
        return left(new ConflictError(`line ${line.lineId} is not a line of this order`))
      if (overridden) continue
      const outstanding = this.outstandingOf(line.lineId)
      if (!outstanding || outstanding.isLessThan(line.quantity))
        return left(
          new ConflictError(
            `line ${line.lineId} would receive more than was ordered; say why to accept it`,
          ),
        )
    }
    return right(undefined)
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

const CLOSED_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'cancelled',
  'rejected',
  'closed',
])

/** One line of a receipt as it was stored, with the quantity as the wire renders it. */
export interface ReceiptLineRecord {
  readonly lineId: string
  readonly itemId: string
  readonly quantity: string
}

function merge(
  received: readonly ReceivedLine[],
  arriving: readonly ReceivedLine[],
): readonly ReceivedLine[] {
  const totals = new Map(received.map((line) => [line.lineId, line.quantity]))
  for (const line of arriving) {
    const current = totals.get(line.lineId)
    totals.set(line.lineId, current ? current.plus(line.quantity) : line.quantity)
  }
  return [...totals].map(([lineId, quantity]) => ({ lineId, quantity }))
}

function subtract(
  received: readonly ReceivedLine[],
  leaving: readonly ReceivedLine[],
): Either<ConflictError, readonly ReceivedLine[]> {
  const totals = new Map(received.map((line) => [line.lineId, line.quantity]))
  for (const line of leaving) {
    const current = totals.get(line.lineId)
    if (!current || current.isLessThan(line.quantity))
      return left(new ConflictError('more is being returned than ever arrived'))
    totals.set(line.lineId, current.minus(line.quantity))
  }
  return right(
    [...totals]
      .filter(([, quantity]) => !quantity.isZero())
      .map(([lineId, quantity]) => ({ lineId, quantity })),
  )
}
