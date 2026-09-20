import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InventoryStockMovedEvent } from '../events/inventory-events'
import { Money, Quantity } from '../value-objects/inventory-values'
import type { MovementOrigin } from '../value-objects/movement-origin'

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
    return this.absorb('receipt', quantity, unitCost, now)
  }

  /** What a unit here is currently worth; null until something has arrived with a cost. */
  unitCost(): Money | null {
    return this.props.averageUnitCost
  }

  onHand(): Quantity {
    return this.props.onHand
  }

  itemId(): string {
    return this.props.itemId
  }

  warehouseId(): string {
    return this.props.warehouseId
  }

  /**
   * Goods leave for another warehouse of the same company.
   *
   * They leave at what they are worth here, and that figure is returned rather than
   * recomputed on the other side: a transfer moves stock, not value, and two averages
   * derived independently would not add up to what left.
   *
   * Only what is available goes. What is reserved is spoken for by an order that expects
   * to find it where it is, and moving it would break that promise silently.
   */
  transferOut(
    quantity: Quantity,
    origin: MovementOrigin,
    now: Date,
  ): Either<ConflictError, Money | null> {
    if (quantity.isZero()) return left(new ConflictError('movement quantity must be positive'))
    if (this.available().isLessThan(quantity))
      return left(new ConflictError('these goods are not available to transfer'))
    const cost = this.props.averageUnitCost
    this.props.onHand = this.props.onHand.minus(quantity)
    this.recordMovement('transfer-out', quantity, cost, now, origin)
    return right(cost)
  }

  /** The other half of a transfer: goods arrive at exactly the cost they left at. */
  transferIn(
    quantity: Quantity,
    unitCost: Money | null,
    origin: MovementOrigin,
    now: Date,
  ): Either<ConflictError, void> {
    if (!unitCost) {
      if (quantity.isZero()) return left(new ConflictError('movement quantity must be positive'))
      this.props.onHand = this.props.onHand.plus(quantity)
      this.recordMovement('transfer-in', quantity, null, now, origin)
      return right(undefined)
    }
    return this.absorb('transfer-in', quantity, unitCost, now, origin)
  }

  /**
   * Stock nobody sold appears: found on a shelf, or a figure that was simply wrong.
   *
   * An adjustment changes how many there are, never what one is worth, so goods enter at
   * the average this balance already carries. A stated cost is accepted only when there
   * is no average to use — the first thing this balance has ever held — because an
   * adjustment that re-prices stock is a receipt pretending not to be one.
   *
   * With neither, the goods come in worth nothing. That is not a loophole but the honest
   * reading of a counter who found something on a shelf and cannot say what it cost; the
   * first receipt to price the item prices these too.
   */
  adjustIn(
    quantity: Quantity,
    stated: Money | null,
    origin: MovementOrigin,
    now: Date,
  ): Either<ConflictError, void> {
    const held = this.props.averageUnitCost
    if (held && stated)
      return left(
        new ConflictError('an adjustment does not re-price stock that already has a cost'),
      )
    const unitCost = held ?? stated
    if (unitCost) return this.absorb('adjustment-in', quantity, unitCost, now, origin)
    if (quantity.isZero()) return left(new ConflictError('movement quantity must be positive'))
    this.props.onHand = this.props.onHand.plus(quantity)
    this.recordMovement('adjustment-in', quantity, null, now, origin)
    return right(undefined)
  }

  /** Stock that is gone: broken, lost, stolen, expired, or never there to begin with. */
  adjustOut(quantity: Quantity, origin: MovementOrigin, now: Date): Either<ConflictError, void> {
    if (quantity.isZero()) return left(new ConflictError('movement quantity must be positive'))
    if (this.available().isLessThan(quantity))
      return left(new ConflictError('these goods are not available to write off'))
    this.props.onHand = this.props.onHand.minus(quantity)
    this.recordMovement('adjustment-out', quantity, this.props.averageUnitCost, now, origin)
    return right(undefined)
  }

  /** Goods arrive and are averaged into what is already here. */
  private absorb(
    kind: 'receipt' | 'transfer-in' | 'adjustment-in',
    quantity: Quantity,
    unitCost: Money,
    now: Date,
    origin?: MovementOrigin,
  ): Either<ConflictError, void> {
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
    this.recordMovement(kind, quantity, unitCost, now, origin)
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
   * Goods come back from a customer, into the promise they were shipped against.
   *
   * They return at the cost they left at — a return is not a purchase, so it moves no
   * average — and they go back to being held for the order, because the customer is still
   * owed them until somebody decides otherwise.
   */
  takeBack(quantity: Quantity, now: Date): Either<ConflictError, void> {
    if (quantity.isZero()) return left(new ConflictError('movement quantity must be positive'))
    this.props.onHand = this.props.onHand.plus(quantity)
    this.props.reserved = this.props.reserved.plus(quantity)
    this.recordMovement('return-in', quantity, this.props.averageUnitCost, now)
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
    kind:
      | 'receipt'
      | 'shipment'
      | 'adjustment-in'
      | 'adjustment-out'
      | 'return-in'
      | 'transfer-in'
      | 'transfer-out',
    quantity: Quantity,
    unitCost: Money | null,
    now: Date,
    origin?: MovementOrigin,
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
        // Read after the movement has been applied, so it is what a unit is worth from
        // here on. Only goods arriving change it, and they change it for every unit.
        averageAfter: this.props.averageUnitCost,
        origin: origin ?? null,
      }),
    )
  }
}
