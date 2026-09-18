import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ProcurementEvent, quantityPayload } from '../events/procurement-events'
import type {
  BusinessDate,
  LineDescription,
  Memo,
  Quantity,
  Reason,
} from '../value-objects/procurement-values'

export const REQUISITION_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'ordered',
  'cancelled',
] as const
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number]

/** What somebody needs, in the quantity they need it. A requisition carries no prices. */
export interface RequisitionLine {
  readonly lineId: string
  readonly itemId: string
  readonly description: LineDescription
  readonly quantity: Quantity
}

export interface RequisitionDecision {
  readonly by: string
  readonly at: Date
  readonly reason: Reason | null
}

interface RequisitionProps {
  tenantId: string
  requestedBy: string
  warehouseId: string
  neededBy: BusinessDate
  justification: Memo | null
  lines: readonly RequisitionLine[]
  status: RequisitionStatus
  submittedBy: string | null
  submittedAt: Date | null
  decision: RequisitionDecision | null
  orderId: string | null
  closure: Reason | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface RequisitionInput {
  readonly tenantId: string
  readonly requestedBy: string
  readonly warehouseId: string
  readonly neededBy: BusinessDate
  readonly justification: Memo | null
  readonly lines: readonly RequisitionLine[]
  readonly now: Date
}

/**
 * A request to buy something, before anyone has been asked what it costs.
 *
 * It is deliberately free of money. What a requisition asserts is a need — this item, this
 * quantity, by this date — and a need is approved or refused on its merits; what it will
 * cost is discovered afterwards, by asking suppliers, and is decided again on the order.
 * Keeping the two apart is what makes the approval of a need auditable separately from the
 * approval of a commitment.
 *
 * Every submitted requisition is decided by someone, and never by the person who submitted
 * it: a need nobody but its author vouches for is not a need the company has agreed to.
 */
export class PurchaseRequisition extends AggregateRoot<RequisitionProps> {
  static open(
    input: RequisitionInput,
    id?: UniqueEntityID,
  ): Either<InvalidInputError, PurchaseRequisition> {
    const checked = checkLines(input.lines)
    if (checked.isLeft()) return left(checked.value)
    return right(
      new PurchaseRequisition(
        {
          tenantId: input.tenantId,
          requestedBy: input.requestedBy,
          warehouseId: input.warehouseId,
          neededBy: input.neededBy,
          justification: input.justification,
          lines: input.lines,
          status: 'draft',
          submittedBy: null,
          submittedAt: null,
          decision: null,
          orderId: null,
          closure: null,
          version: 0,
          createdAt: input.now,
          updatedAt: input.now,
        },
        id,
      ),
    )
  }

  static rehydrate(props: RequisitionProps, id: UniqueEntityID): PurchaseRequisition {
    return new PurchaseRequisition(props, id)
  }

  get tenantId(): string {
    return this.props.tenantId
  }

  get status(): RequisitionStatus {
    return this.props.status
  }

  get warehouseId(): string {
    return this.props.warehouseId
  }

  get orderId(): string | null {
    return this.props.orderId
  }

  lines(): readonly RequisitionLine[] {
    return this.props.lines
  }

  lineOf(lineId: string): RequisitionLine | undefined {
    return this.props.lines.find((line) => line.lineId === lineId)
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  revise(
    change: {
      readonly neededBy: BusinessDate
      readonly justification: Memo | null
      readonly lines: readonly RequisitionLine[]
    },
    now: Date,
  ): Either<InvalidInputError | ConflictError, void> {
    if (this.props.status !== 'draft')
      return left(new ConflictError('only a draft requisition can be revised'))
    const checked = checkLines(change.lines)
    if (checked.isLeft()) return left(checked.value)
    this.props.neededBy = change.neededBy
    this.props.justification = change.justification
    this.props.lines = change.lines
    this.advance(now)
    return right(undefined)
  }

  submit(actor: string, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'draft')
      return left(new ConflictError('only a draft requisition can be submitted'))
    this.props.status = 'submitted'
    this.props.submittedBy = actor
    this.props.submittedAt = now
    this.advance(now)
    this.addDomainEvent(
      this.event('procurement.requisition.submitted', now, {
        requestedBy: this.props.requestedBy,
        submittedBy: actor,
        warehouseId: this.props.warehouseId,
        neededBy: this.props.neededBy.value,
        lines: this.props.lines.map((line) => ({
          lineId: line.lineId,
          itemId: line.itemId,
          quantity: quantityPayload(line.quantity),
        })),
      }),
    )
    return right(undefined)
  }

  /** Four eyes: whoever submitted the requisition cannot be the one who approves it. */
  approve(actor: string, now: Date): Either<ConflictError, void> {
    const decidable = this.decidable(actor)
    if (decidable.isLeft()) return decidable
    this.props.status = 'approved'
    this.props.decision = { by: actor, at: now, reason: null }
    this.advance(now)
    this.addDomainEvent(
      this.event('procurement.requisition.approved', now, {
        approvedBy: actor,
        warehouseId: this.props.warehouseId,
      }),
    )
    return right(undefined)
  }

  reject(actor: string, reason: Reason, now: Date): Either<ConflictError, void> {
    const decidable = this.decidable(actor)
    if (decidable.isLeft()) return decidable
    this.props.status = 'rejected'
    this.props.decision = { by: actor, at: now, reason }
    this.advance(now)
    this.addDomainEvent(
      this.event('procurement.requisition.rejected', now, {
        rejectedBy: actor,
        reason: reason.value,
      }),
    )
    return right(undefined)
  }

  cancel(reason: Reason, now: Date): Either<ConflictError, void> {
    if (this.props.status === 'ordered')
      return left(
        new ConflictError('a requisition already turned into an order cannot be cancelled'),
      )
    if (this.props.status === 'cancelled' || this.props.status === 'rejected')
      return left(new ConflictError(`this requisition is already ${this.props.status}`))
    this.props.status = 'cancelled'
    this.props.closure = reason
    this.advance(now)
    return right(undefined)
  }

  /** The order that answered this requisition. One requisition becomes at most one order. */
  markOrdered(orderId: string, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'approved')
      return left(new ConflictError('only an approved requisition can be turned into an order'))
    this.props.status = 'ordered'
    this.props.orderId = orderId
    this.advance(now)
    return right(undefined)
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    requestedBy: string
    warehouseId: string
    neededBy: string
    justification: string | null
    status: RequisitionStatus
    submittedBy: string | null
    submittedAt: Date | null
    decidedBy: string | null
    decidedAt: Date | null
    decisionReason: string | null
    orderId: string | null
    closureReason: string | null
    version: number
    createdAt: Date
    updatedAt: Date
    lines: readonly {
      lineId: string
      itemId: string
      description: string
      quantity: string
    }[]
  }> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      requestedBy: this.props.requestedBy,
      warehouseId: this.props.warehouseId,
      neededBy: this.props.neededBy.value,
      justification: this.props.justification?.value ?? null,
      status: this.props.status,
      submittedBy: this.props.submittedBy,
      submittedAt: this.props.submittedAt,
      decidedBy: this.props.decision?.by ?? null,
      decidedAt: this.props.decision?.at ?? null,
      decisionReason: this.props.decision?.reason?.value ?? null,
      orderId: this.props.orderId,
      closureReason: this.props.closure?.value ?? null,
      version: this.props.version,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
      lines: this.props.lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        description: line.description.value,
        quantity: line.quantity.toString(),
      })),
    })
  }

  private decidable(actor: string): Either<ConflictError, void> {
    if (this.props.status !== 'submitted')
      return left(new ConflictError('there is no submitted requisition to decide'))
    if (this.props.submittedBy === actor)
      return left(new ConflictError('the person who submitted the requisition cannot decide it'))
    return right(undefined)
  }

  private event(
    type: string,
    now: Date,
    payload: Readonly<Record<string, unknown>>,
  ): ProcurementEvent {
    return new ProcurementEvent(type, this.id, this.props.tenantId, now, {
      requisitionId: this.id.toString(),
      requisitionVersion: this.props.version,
      ...payload,
    })
  }

  private advance(now: Date): void {
    this.props.version += 1
    this.props.updatedAt = now
  }
}

function checkLines(lines: readonly RequisitionLine[]): Either<InvalidInputError, void> {
  if (lines.length === 0)
    return left(new InvalidInputError('/lines', 'a requisition requires at least one line'))
  if (lines.some((line) => line.quantity.isZero()))
    return left(new InvalidInputError('/lines/quantity', 'requested quantities must be positive'))
  if (new Set(lines.map((line) => line.lineId)).size !== lines.length)
    return left(new InvalidInputError('/lines', 'line identifiers must be unique'))
  if (new Set(lines.map((line) => line.itemId)).size !== lines.length)
    return left(new InvalidInputError('/lines', 'ask for each item once, in a single line'))
  return right(undefined)
}
