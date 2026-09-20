import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { Note, Quantity } from '../value-objects/inventory-values'

export interface TransferLine {
  readonly itemId: string
  readonly quantity: Quantity
}

interface StockTransferProps {
  tenantId: string
  sourceWarehouseId: string
  destinationWarehouseId: string
  lines: readonly TransferLine[]
  note: Note | null
  movedBy: string
  movedAt: Date
}

/**
 * Goods move from one of the company's warehouses to another.
 *
 * A transfer has no states to pass through. It is not asked for, approved and then
 * carried out: by the time anybody records one, the goods have already been picked up
 * and put down, and the only useful thing to write is what moved and who moved it.
 * Correcting one is another transfer in the other direction, never an edit, because the
 * two movements it wrote are already in the ledger the balances are derived from.
 *
 * Nor does it wait for an allowance. A transfer changes where stock is, not how much of
 * it the company owns, so there is nothing for a second person to protect.
 */
export class StockTransfer extends AggregateRoot<StockTransferProps> {
  static rehydrate(props: StockTransferProps, id: UniqueEntityID): StockTransfer {
    return new StockTransfer(props, id)
  }

  static post(
    props: {
      tenantId: string
      sourceWarehouseId: string
      destinationWarehouseId: string
      lines: readonly TransferLine[]
      note: Note | null
      movedBy: string
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<ConflictError, StockTransfer> {
    if (props.lines.length === 0)
      return left(new ConflictError('a transfer moves at least one item'))
    if (props.sourceWarehouseId === props.destinationWarehouseId)
      return left(new ConflictError('a transfer needs two different warehouses'))
    if (props.lines.some((line) => line.quantity.isZero()))
      return left(new ConflictError('transfer quantities must be positive'))
    const items = new Set(props.lines.map((line) => line.itemId))
    if (items.size !== props.lines.length)
      return left(new ConflictError('an item appears at most once on a transfer'))
    return right(new StockTransfer({ ...props, movedAt: props.now }, id))
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  lines(): readonly TransferLine[] {
    return this.props.lines
  }

  source(): string {
    return this.props.sourceWarehouseId
  }

  destination(): string {
    return this.props.destinationWarehouseId
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    sourceWarehouseId: string
    destinationWarehouseId: string
    lines: readonly { itemId: string; quantity: string }[]
    note: string | null
    movedBy: string
    movedAt: Date
  }> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      sourceWarehouseId: this.props.sourceWarehouseId,
      destinationWarehouseId: this.props.destinationWarehouseId,
      lines: this.props.lines.map((line) => ({
        itemId: line.itemId,
        quantity: line.quantity.toString(),
      })),
      note: this.props.note?.value ?? null,
      movedBy: this.props.movedBy,
      movedAt: this.props.movedAt,
    })
  }
}
