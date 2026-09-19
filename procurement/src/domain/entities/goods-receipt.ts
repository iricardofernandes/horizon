import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { ReceiptLine } from '../services/receiving'
import type {
  BusinessDate,
  Currency,
  Memo,
  Money,
  Reason,
} from '../value-objects/procurement-values'

export const RECEIPT_STATUSES = ['recorded', 'returned'] as const
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number]

interface ReceiptProps {
  tenantId: string
  orderId: string
  warehouseId: string
  receivedOn: BusinessDate
  receivedBy: string
  currency: Currency
  lines: readonly ReceiptLine[]
  /** The share of the order's total these goods carry, and therefore what they made owed. */
  value: Money
  notes: Memo | null
  overrideReason: Reason | null
  status: ReceiptStatus
  returnedBy: string | null
  returnedAt: Date | null
  returnReason: Reason | null
  createdAt: Date
}

export interface ReceiptInput {
  readonly tenantId: string
  readonly orderId: string
  readonly warehouseId: string
  readonly receivedOn: BusinessDate
  readonly receivedBy: string
  readonly currency: Currency
  readonly lines: readonly ReceiptLine[]
  readonly value: Money
  readonly notes: Memo | null
  readonly overrideReason: Reason | null
  readonly now: Date
}

/**
 * One delivery against a purchase order: what arrived, on what day, and what it made owed.
 *
 * It is the record of a physical event, so it is never edited. What it says is what the
 * warehouse counted; a delivery that turns out to be wrong is returned, which leaves both
 * the receipt and the return in the record rather than replacing the first with the second
 * (ADR 0042).
 */
export class GoodsReceipt extends AggregateRoot<ReceiptProps> {
  static record(input: ReceiptInput, id?: UniqueEntityID): GoodsReceipt {
    return new GoodsReceipt(
      {
        tenantId: input.tenantId,
        orderId: input.orderId,
        warehouseId: input.warehouseId,
        receivedOn: input.receivedOn,
        receivedBy: input.receivedBy,
        currency: input.currency,
        lines: input.lines,
        value: input.value,
        notes: input.notes,
        overrideReason: input.overrideReason,
        status: 'recorded',
        returnedBy: null,
        returnedAt: null,
        returnReason: null,
        createdAt: input.now,
      },
      id,
    )
  }

  static rehydrate(props: ReceiptProps, id: UniqueEntityID): GoodsReceipt {
    return new GoodsReceipt(props, id)
  }

  get tenantId(): string {
    return this.props.tenantId
  }

  get orderId(): string {
    return this.props.orderId
  }

  get status(): ReceiptStatus {
    return this.props.status
  }

  get value(): Money {
    return this.props.value
  }

  lines(): readonly ReceiptLine[] {
    return this.props.lines
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  giveBack(actor: string, reason: Reason, now: Date): Either<ConflictError, void> {
    if (this.props.status === 'returned')
      return left(new ConflictError('this delivery has already been returned'))
    this.props.status = 'returned'
    this.props.returnedBy = actor
    this.props.returnedAt = now
    this.props.returnReason = reason
    return right(undefined)
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    orderId: string
    warehouseId: string
    receivedOn: string
    receivedBy: string
    currency: string
    value: string
    notes: string | null
    overrideReason: string | null
    status: ReceiptStatus
    returnedBy: string | null
    returnedAt: Date | null
    returnReason: string | null
    createdAt: Date
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
      orderId: this.props.orderId,
      warehouseId: this.props.warehouseId,
      receivedOn: this.props.receivedOn.value,
      receivedBy: this.props.receivedBy,
      currency: this.props.currency.value,
      value: this.props.value.amount.toString(),
      notes: this.props.notes?.value ?? null,
      overrideReason: this.props.overrideReason?.value ?? null,
      status: this.props.status,
      returnedBy: this.props.returnedBy,
      returnedAt: this.props.returnedAt,
      returnReason: this.props.returnReason?.value ?? null,
      createdAt: this.props.createdAt,
      lines: this.props.lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        description: line.description,
        quantity: line.quantity.toString(),
        unitPrice: line.unitPrice.amount.toString(),
        lineTotal: line.lineTotal.amount.toString(),
      })),
    })
  }
}
