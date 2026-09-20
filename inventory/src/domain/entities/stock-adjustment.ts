import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { Money, Note, Quantity } from '../value-objects/inventory-values'
import { type AdjustmentReason, reasonAdmits } from '../value-objects/movement-origin'
import type { LotCode } from '../value-objects/tracking'

export const ADJUSTMENT_STATUSES = ['pending', 'posted', 'rejected'] as const
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number]

export const APPROVAL_STATES = ['not-required', 'pending', 'approved', 'rejected'] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]

export type AdjustmentDirection = 'in' | 'out'

interface StockAdjustmentProps {
  tenantId: string
  warehouseId: string
  itemId: string
  direction: AdjustmentDirection
  /**
   * Which boxes, for an item the workspace identifies.
   *
   * Carried on the adjustment rather than supplied when it is allowed, because the
   * decision a second person is being asked to take is about a particular lot: "write off
   * four" and "write off four of AB-1204" are not the same request.
   */
  lot: LotCode | null
  quantity: Quantity
  reason: AdjustmentReason
  note: Note | null
  /** Stated only when the goods have never had a cost; otherwise the balance's own. */
  statedUnitCost: Money | null
  /** What this adjustment was judged to be worth when it was asked for. */
  value: Money | null
  status: AdjustmentStatus
  approvalState: ApprovalState
  requestedBy: string
  requestedAt: Date
  decidedBy: string | null
  decidedAt: Date | null
  decisionReason: Note | null
  postedAt: Date | null
  updatedAt: Date
}

/**
 * Somebody changes how much stock there is, with nobody having bought or sold anything.
 *
 * This is the one command in the module that can make the figures say whatever the person
 * typing wants, which is why it is the only one that answers to an allowance: past a
 * value the workspace sets, the goods do not move until a second person says so, and that
 * person is never the one who asked (ADR 0025 — four eyes, in the aggregate and in a
 * table constraint).
 *
 * What it is worth is judged when it is asked for, against the cost the goods carry then.
 * Posting it later uses the cost they carry then — an approval that sat for a week does
 * not get to move stock at last week's price.
 */
export class StockAdjustment extends AggregateRoot<StockAdjustmentProps> {
  static rehydrate(props: StockAdjustmentProps, id: UniqueEntityID): StockAdjustment {
    return new StockAdjustment(props, id)
  }

  static request(
    props: {
      tenantId: string
      warehouseId: string
      itemId: string
      direction: AdjustmentDirection
      lot: LotCode | null
      quantity: Quantity
      reason: AdjustmentReason
      note: Note | null
      statedUnitCost: Money | null
      value: Money | null
      approvalRequired: boolean
      requestedBy: string
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<ConflictError, StockAdjustment> {
    if (props.quantity.isZero())
      return left(new ConflictError('an adjustment quantity must be positive'))
    if (!reasonAdmits(props.reason, props.direction))
      return left(
        new ConflictError(
          `stock is not ${props.direction === 'in' ? 'added' : 'removed'} for this reason`,
        ),
      )
    return right(
      new StockAdjustment(
        {
          tenantId: props.tenantId,
          warehouseId: props.warehouseId,
          itemId: props.itemId,
          direction: props.direction,
          lot: props.lot,
          quantity: props.quantity,
          reason: props.reason,
          note: props.note,
          statedUnitCost: props.statedUnitCost,
          value: props.value,
          status: props.approvalRequired ? 'pending' : 'posted',
          approvalState: props.approvalRequired ? 'pending' : 'not-required',
          requestedBy: props.requestedBy,
          requestedAt: props.now,
          decidedBy: null,
          decidedAt: null,
          decisionReason: null,
          postedAt: props.approvalRequired ? null : props.now,
          updatedAt: props.now,
        },
        id,
      ),
    )
  }

  /** Allowing somebody else's write-off. Allowing your own is not an approval. */
  approve(actor: string, now: Date): Either<ConflictError, void> {
    if (this.props.approvalState !== 'pending')
      return left(new ConflictError('this adjustment is not waiting for a decision'))
    if (actor === this.props.requestedBy)
      return left(new ConflictError('the person who asked for an adjustment cannot allow it'))
    this.props.approvalState = 'approved'
    this.props.status = 'posted'
    this.props.decidedBy = actor
    this.props.decidedAt = now
    this.props.postedAt = now
    this.props.updatedAt = now
    return right(undefined)
  }

  reject(actor: string, reason: Note, now: Date): Either<ConflictError, void> {
    if (this.props.approvalState !== 'pending')
      return left(new ConflictError('this adjustment is not waiting for a decision'))
    if (actor === this.props.requestedBy)
      return left(new ConflictError('the person who asked for an adjustment cannot refuse it'))
    this.props.approvalState = 'rejected'
    this.props.status = 'rejected'
    this.props.decidedBy = actor
    this.props.decidedAt = now
    this.props.decisionReason = reason
    this.props.updatedAt = now
    return right(undefined)
  }

  /** True when this adjustment's movement should be written in the current transaction. */
  posts(): boolean {
    return this.props.status === 'posted'
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  status(): AdjustmentStatus {
    return this.props.status
  }

  approvalState(): ApprovalState {
    return this.props.approvalState
  }

  value(): Money | null {
    return this.props.value
  }

  direction(): AdjustmentDirection {
    return this.props.direction
  }

  lot(): LotCode | null {
    return this.props.lot
  }

  quantity(): Quantity {
    return this.props.quantity
  }

  reason(): AdjustmentReason {
    return this.props.reason
  }

  statedUnitCost(): Money | null {
    return this.props.statedUnitCost
  }

  itemId(): string {
    return this.props.itemId
  }

  warehouseId(): string {
    return this.props.warehouseId
  }

  requestedBy(): string {
    return this.props.requestedBy
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    warehouseId: string
    itemId: string
    direction: AdjustmentDirection
    lot: string | null
    quantity: string
    reason: AdjustmentReason
    note: string | null
    statedUnitCost: { amount: string; currency: string } | null
    value: { amount: string; currency: string } | null
    status: AdjustmentStatus
    approvalState: ApprovalState
    requestedBy: string
    requestedAt: Date
    decidedBy: string | null
    decidedAt: Date | null
    decisionReason: string | null
    postedAt: Date | null
    updatedAt: Date
  }> {
    const money = (value: Money | null) =>
      value ? { amount: value.amount.toString(), currency: value.currency.value } : null
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      warehouseId: this.props.warehouseId,
      itemId: this.props.itemId,
      direction: this.props.direction,
      lot: this.props.lot?.value ?? null,
      quantity: this.props.quantity.toString(),
      reason: this.props.reason,
      note: this.props.note?.value ?? null,
      statedUnitCost: money(this.props.statedUnitCost),
      value: money(this.props.value),
      status: this.props.status,
      approvalState: this.props.approvalState,
      requestedBy: this.props.requestedBy,
      requestedAt: this.props.requestedAt,
      decidedBy: this.props.decidedBy,
      decidedAt: this.props.decidedAt,
      decisionReason: this.props.decisionReason?.value ?? null,
      postedAt: this.props.postedAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
