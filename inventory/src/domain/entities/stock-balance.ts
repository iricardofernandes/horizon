import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InventoryStockMovedEvent } from '../events/inventory-events'
import { Money, Quantity } from '../value-objects/inventory-values'

interface StockBalanceProps {
  tenantId: string
  itemId: string
  warehouseId: string
  onHand: Quantity
  reserved: Quantity
  averageUnitCost: Money | null
  version: number
  updatedAt: Date
}

export interface StockBalanceSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly itemId: string
  readonly warehouseId: string
  readonly onHand: string
  readonly reserved: string
  readonly available: string
  readonly averageUnitCost: { amount: string; currency: string } | null
  readonly version: number
  readonly updatedAt: Date
}

export class StockBalance extends AggregateRoot<StockBalanceProps> {
  static rehydrate(props: StockBalanceProps, id: UniqueEntityID): StockBalance {
    return new StockBalance(props, id)
  }

  static open(
    props: { tenantId: string; itemId: string; warehouseId: string; now?: Date },
    id?: UniqueEntityID,
  ): StockBalance {
    return new StockBalance(
      {
        tenantId: props.tenantId,
        itemId: props.itemId,
        warehouseId: props.warehouseId,
        onHand: Quantity.fromMicros(0n),
        reserved: Quantity.fromMicros(0n),
        averageUnitCost: null,
        version: 0,
        updatedAt: props.now ?? new Date(),
      },
      id,
    )
  }
  available(): Quantity {
    return this.props.onHand.minus(this.props.reserved)
  }
  receive(quantity: Quantity, unitCost: Money, now: Date): Either<ConflictError, void> {
    if (quantity.isZero()) return left(new ConflictError('movement quantity must be positive'))
    const previousCost = this.props.averageUnitCost
    if (previousCost && !previousCost.currency.equals(unitCost.currency))
      return left(new ConflictError('movement currency differs from the balance currency'))
    const nextOnHand = this.props.onHand.plus(quantity)
    const previousValue = this.props.onHand.micros * (previousCost?.amount ?? 0n)
    const receivedValue = quantity.micros * unitCost.amount
    const roundedAverage =
      (previousValue + receivedValue + nextOnHand.micros / 2n) / nextOnHand.micros
    this.props.onHand = nextOnHand
    this.props.averageUnitCost = Money.fromAmount(roundedAverage, unitCost.currency)
    this.recordMovement('receipt', quantity, unitCost, now)
    return right(undefined)
  }
  hold(quantity: Quantity, now: Date): Either<ConflictError, void> {
    if (quantity.isZero()) return left(new ConflictError('reservation quantity must be positive'))
    if (this.available().isLessThan(quantity))
      return left(new ConflictError('insufficient available stock'))
    this.props.reserved = this.props.reserved.plus(quantity)
    this.props.updatedAt = now
    return right(undefined)
  }
  release(quantity: Quantity, now: Date): Either<ConflictError, void> {
    if (quantity.isZero() || this.props.reserved.isLessThan(quantity))
      return left(new ConflictError('release exceeds reserved stock'))
    this.props.reserved = this.props.reserved.minus(quantity)
    this.props.updatedAt = now
    return right(undefined)
  }
  ship(quantity: Quantity, now: Date): Either<ConflictError, void> {
    if (quantity.isZero() || this.props.reserved.isLessThan(quantity))
      return left(new ConflictError('shipment exceeds reserved stock'))
    this.props.reserved = this.props.reserved.minus(quantity)
    this.props.onHand = this.props.onHand.minus(quantity)
    this.recordMovement('shipment', quantity, this.props.averageUnitCost, now)
    return right(undefined)
  }
  /**
   * Goods leave stock without having been sold — a delivery sent back to its supplier.
   *
   * What was reserved for somebody else is untouchable: refusing here is what stops a
   * return from quietly cancelling a promise already made to a customer.
   */
  giveBack(quantity: Quantity, now: Date): Either<ConflictError, void> {
    if (quantity.isZero()) return left(new ConflictError('movement quantity must be positive'))
    if (this.available().isLessThan(quantity))
      return left(new ConflictError('these goods are no longer available to return'))
    this.props.onHand = this.props.onHand.minus(quantity)
    this.recordMovement('adjustment-out', quantity, this.props.averageUnitCost, now)
    return right(undefined)
  }
  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }
  toSnapshot(): Readonly<StockBalanceSnapshot> {
    const cost = this.props.averageUnitCost
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      itemId: this.props.itemId,
      warehouseId: this.props.warehouseId,
      onHand: this.props.onHand.toString(),
      reserved: this.props.reserved.toString(),
      available: this.available().toString(),
      averageUnitCost: cost
        ? { amount: cost.amount.toString(), currency: cost.currency.value }
        : null,
      version: this.props.version,
      updatedAt: this.props.updatedAt,
    })
  }
  private recordMovement(
    kind: 'receipt' | 'shipment' | 'adjustment-out',
    quantity: Quantity,
    unitCost: Money | null,
    now: Date,
  ): void {
    this.props.version += 1
    this.props.updatedAt = now
    this.addDomainEvent(
      new InventoryStockMovedEvent(this.id, this.props.tenantId, now, {
        movementId: new UniqueEntityID().toString(),
        itemId: this.props.itemId,
        warehouseId: this.props.warehouseId,
        kind,
        balanceVersion: this.props.version,
        quantity,
        balanceAfter: this.props.onHand,
        unitCost,
      }),
    )
  }
}
