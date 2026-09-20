import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { Note, Quantity } from '../value-objects/inventory-values'
import type { ApprovalState } from './stock-adjustment'

export const COUNT_STATUSES = ['open', 'pending', 'closed', 'cancelled'] as const
export type CountStatus = (typeof COUNT_STATUSES)[number]

export interface CountLine {
  readonly itemId: string
  /** What the system said when the sheet was opened — never recomputed afterwards. */
  readonly expected: Quantity
  readonly counted: Quantity | null
}

/** A line whose count disagreed with the sheet, as the movement it becomes. */
export interface Variance {
  readonly itemId: string
  readonly direction: 'in' | 'out'
  readonly quantity: Quantity
}

interface StockCountProps {
  tenantId: string
  warehouseId: string
  lines: readonly CountLine[]
  note: Note | null
  status: CountStatus
  approvalState: ApprovalState
  openedBy: string
  openedAt: Date
  closedBy: string | null
  closedAt: Date | null
  decidedBy: string | null
  decidedAt: Date | null
  closureReason: Note | null
  updatedAt: Date
}

/**
 * Somebody walks the aisles and writes down what is actually there.
 *
 * The sheet freezes what the system expected at the moment it was opened, because that
 * is the figure the counter is disagreeing with. Closing it posts the **difference**, not
 * the figure counted: if the shelf said a hundred, the counter found ninety-eight, and
 * ten were shipped while they were counting, the balance ends at eighty-eight. Writing
 * ninety-eight over it would quietly undo a delivery that really happened.
 *
 * A line nobody counted is left alone. Not counting something is not the same as counting
 * zero of it, and a sheet that treated the two alike would write off every item the
 * counter did not reach.
 */
export class StockCount extends AggregateRoot<StockCountProps> {
  static rehydrate(props: StockCountProps, id: UniqueEntityID): StockCount {
    return new StockCount(props, id)
  }

  static open(
    props: {
      tenantId: string
      warehouseId: string
      lines: readonly { itemId: string; expected: Quantity }[]
      note: Note | null
      openedBy: string
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<ConflictError, StockCount> {
    if (props.lines.length === 0)
      return left(new ConflictError('a count sheet needs at least one item on it'))
    const items = new Set(props.lines.map((line) => line.itemId))
    if (items.size !== props.lines.length)
      return left(new ConflictError('an item appears at most once on a count sheet'))
    return right(
      new StockCount(
        {
          tenantId: props.tenantId,
          warehouseId: props.warehouseId,
          lines: props.lines.map((line) => ({ ...line, counted: null })),
          note: props.note,
          status: 'open',
          approvalState: 'not-required',
          openedBy: props.openedBy,
          openedAt: props.now,
          closedBy: null,
          closedAt: null,
          decidedBy: null,
          decidedAt: null,
          closureReason: null,
          updatedAt: props.now,
        },
        id,
      ),
    )
  }

  /** What the counter found, for some or all of the sheet; counting again overwrites. */
  record(
    counts: readonly { itemId: string; counted: Quantity }[],
    now: Date,
  ): Either<ConflictError, void> {
    if (this.props.status !== 'open')
      return left(new ConflictError('only an open count takes figures'))
    if (counts.length === 0) return left(new ConflictError('record at least one counted item'))
    const known = new Map(this.props.lines.map((line) => [line.itemId, line]))
    for (const count of counts)
      if (!known.has(count.itemId))
        return left(new ConflictError('this item is not on the count sheet'))
    const counted = new Map(counts.map((count) => [count.itemId, count.counted]))
    this.props.lines = this.props.lines.map((line) =>
      counted.has(line.itemId) ? { ...line, counted: counted.get(line.itemId) ?? null } : line,
    )
    this.props.updatedAt = now
    return right(undefined)
  }

  /**
   * The counting is over.
   *
   * Past the workspace's allowance the sheet waits for a second person exactly as an
   * adjustment does, because a count that writes off enough stock is a write-off whatever
   * it is called.
   */
  close(
    actor: string,
    now: Date,
    options: { approvalRequired: boolean },
  ): Either<ConflictError, void> {
    if (this.props.status !== 'open') return left(new ConflictError('this count is not open'))
    if (this.props.lines.every((line) => line.counted === null))
      return left(new ConflictError('nothing on this sheet has been counted'))
    this.props.closedBy = actor
    this.props.closedAt = now
    this.props.status = options.approvalRequired ? 'pending' : 'closed'
    this.props.approvalState = options.approvalRequired ? 'pending' : 'not-required'
    this.props.updatedAt = now
    return right(undefined)
  }

  approve(actor: string, now: Date): Either<ConflictError, void> {
    if (this.props.approvalState !== 'pending')
      return left(new ConflictError('this count is not waiting for a decision'))
    if (actor === this.props.closedBy)
      return left(new ConflictError('the person who closed a count cannot allow its differences'))
    this.props.approvalState = 'approved'
    this.props.status = 'closed'
    this.props.decidedBy = actor
    this.props.decidedAt = now
    this.props.updatedAt = now
    return right(undefined)
  }

  reject(actor: string, reason: Note, now: Date): Either<ConflictError, void> {
    if (this.props.approvalState !== 'pending')
      return left(new ConflictError('this count is not waiting for a decision'))
    if (actor === this.props.closedBy)
      return left(new ConflictError('the person who closed a count cannot refuse its differences'))
    this.props.approvalState = 'rejected'
    this.props.status = 'cancelled'
    this.props.decidedBy = actor
    this.props.decidedAt = now
    this.props.closureReason = reason
    this.props.updatedAt = now
    return right(undefined)
  }

  /**
   * The sheet is abandoned and nothing it found is posted.
   *
   * A count abandoned while it was waiting keeps `pending` as its approval state: nobody
   * decided, and recording that as "not required" would claim the control was never in
   * the way.
   */
  cancel(reason: Note, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'open' && this.props.status !== 'pending')
      return left(new ConflictError('a count that has been settled cannot be abandoned'))
    this.props.status = 'cancelled'
    this.props.closureReason = reason
    this.props.updatedAt = now
    return right(undefined)
  }

  /** The lines that disagreed, as movements. A line nobody counted is not one of them. */
  variances(): readonly Variance[] {
    const variances: Variance[] = []
    for (const line of this.props.lines) {
      if (line.counted === null) continue
      if (line.counted.micros === line.expected.micros) continue
      const grew = line.expected.isLessThan(line.counted)
      variances.push({
        itemId: line.itemId,
        direction: grew ? 'in' : 'out',
        quantity: grew ? line.counted.minus(line.expected) : line.expected.minus(line.counted),
      })
    }
    return variances
  }

  /** True when closing it should write its variances in the current transaction. */
  posts(): boolean {
    return this.props.status === 'closed'
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  warehouseId(): string {
    return this.props.warehouseId
  }

  status(): CountStatus {
    return this.props.status
  }

  approvalState(): ApprovalState {
    return this.props.approvalState
  }

  lines(): readonly CountLine[] {
    return this.props.lines
  }

  closedBy(): string | null {
    return this.props.closedBy
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    warehouseId: string
    lines: readonly { itemId: string; expected: string; counted: string | null }[]
    note: string | null
    status: CountStatus
    approvalState: ApprovalState
    openedBy: string
    openedAt: Date
    closedBy: string | null
    closedAt: Date | null
    decidedBy: string | null
    decidedAt: Date | null
    closureReason: string | null
    updatedAt: Date
  }> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      warehouseId: this.props.warehouseId,
      lines: this.props.lines.map((line) => ({
        itemId: line.itemId,
        expected: line.expected.toString(),
        counted: line.counted?.toString() ?? null,
      })),
      note: this.props.note?.value ?? null,
      status: this.props.status,
      approvalState: this.props.approvalState,
      openedBy: this.props.openedBy,
      openedAt: this.props.openedAt,
      closedBy: this.props.closedBy,
      closedAt: this.props.closedAt,
      decidedBy: this.props.decidedBy,
      decidedAt: this.props.decidedAt,
      closureReason: this.props.closureReason?.value ?? null,
      updatedAt: this.props.updatedAt,
    })
  }
}
