import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InventoryStockMovedEvent } from '../events/inventory-events'
import { Money, Quantity } from '../value-objects/inventory-values'
import type { MovementOrigin } from '../value-objects/movement-origin'
import { type ItemTracking, UNTRACKED } from '../value-objects/tracking'
import { LotBook, type LotEntry, type LotHolding, type LotPick } from './lot-book'

interface StockBalanceProps {
  tenantId: string
  itemId: string
  warehouseId: string
  onHand: Quantity
  reserved: Quantity
  averageUnitCost: Money | null
  tracking: ItemTracking
  lots: LotBook
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

type MovementKind =
  | 'receipt'
  | 'shipment'
  | 'adjustment-in'
  | 'adjustment-out'
  | 'return-in'
  | 'transfer-in'
  | 'transfer-out'

export class StockBalance extends AggregateRoot<StockBalanceProps> {
  static rehydrate(props: StockBalanceProps, id: UniqueEntityID): StockBalance {
    return new StockBalance(props, id)
  }

  static open(
    props: {
      tenantId: string
      itemId: string
      warehouseId: string
      tracking?: ItemTracking
      now?: Date
    },
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
        tracking: props.tracking ?? UNTRACKED,
        lots: new LotBook(),
        version: 0,
        updatedAt: props.now ?? new Date(),
      },
      id,
    )
  }

  /**
   * What is free to promise somebody, on the day it is being asked about.
   *
   * Expired goods are on the shelf and have not stopped being the company's, so they are
   * still on hand — but nobody can be sold them, so they are not available. That split is
   * the whole of what an expiry date does here: it moves stock out of what can be
   * promised without pretending it has ceased to exist.
   */
  available(now: Date): Quantity {
    const sellable = this.sellable(now)
    return sellable.isLessThan(this.props.reserved)
      ? Quantity.fromMicros(0n)
      : sellable.minus(this.props.reserved)
  }

  /** On hand, less whatever has gone off. Equal to on hand for an item nobody tracks. */
  sellable(now: Date): Quantity {
    return this.isTracked() ? this.props.lots.sellable(now) : this.props.onHand
  }

  isTracked(): boolean {
    return this.props.tracking.kind === 'lot'
  }

  tracking(): ItemTracking {
    return this.props.tracking
  }

  lots(): readonly LotHolding[] {
    return this.props.lots.lots()
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

  receive(
    quantity: Quantity,
    unitCost: Money,
    now: Date,
    lots: readonly LotEntry[] | null = null,
    origin?: MovementOrigin,
  ): Either<ConflictError, void> {
    return this.absorb('receipt', quantity, unitCost, now, origin, lots)
  }

  /**
   * Goods leave for another warehouse of the same company.
   *
   * They leave at what they are worth here, and that figure is returned rather than
   * recomputed on the other side: a transfer moves stock, not value, and two averages
   * derived independently would not add up to what left. The lots drawn come back too,
   * because the other warehouse must take in the very same boxes — a transfer moves where
   * goods are, never which goods they are.
   *
   * Only what is available goes. What is reserved is spoken for by an order that expects
   * to find it where it is, and moving it would break that promise silently.
   */
  transferOut(
    quantity: Quantity,
    origin: MovementOrigin,
    now: Date,
    picks: readonly LotPick[] | null = null,
  ): Either<ConflictError, { cost: Money | null; drawn: readonly LotEntry[] }> {
    // Expired goods may be transferred when somebody names them: moving them to where
    // they will be dealt with is exactly what a warehouse does with stock that has gone.
    const gone = this.remove(
      quantity,
      picks,
      now,
      'these goods are not available to transfer',
      true,
    )
    if (gone.isLeft()) return left(gone.value)
    const cost = this.props.averageUnitCost
    this.recordMovement('transfer-out', quantity, cost, now, origin, gone.value)
    return right({ cost, drawn: gone.value })
  }

  /** The other half of a transfer: goods arrive at exactly the cost they left at. */
  transferIn(
    quantity: Quantity,
    unitCost: Money | null,
    origin: MovementOrigin,
    now: Date,
    lots: readonly LotEntry[] | null = null,
  ): Either<ConflictError, void> {
    if (unitCost) return this.absorb('transfer-in', quantity, unitCost, now, origin, lots)
    const added = this.add(quantity, lots, now)
    if (added.isLeft()) return left(added.value)
    this.recordMovement('transfer-in', quantity, null, now, origin, added.value)
    return right(undefined)
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
    lots: readonly LotEntry[] | null = null,
  ): Either<ConflictError, void> {
    const held = this.props.averageUnitCost
    if (held && stated)
      return left(
        new ConflictError('an adjustment does not re-price stock that already has a cost'),
      )
    const unitCost = held ?? stated
    if (unitCost) return this.absorb('adjustment-in', quantity, unitCost, now, origin, lots)
    const added = this.add(quantity, lots, now)
    if (added.isLeft()) return left(added.value)
    this.recordMovement('adjustment-in', quantity, null, now, origin, added.value)
    return right(undefined)
  }

  /** Stock that is gone: broken, lost, stolen, expired, or never there to begin with. */
  adjustOut(
    quantity: Quantity,
    origin: MovementOrigin,
    now: Date,
    picks: readonly LotPick[] | null = null,
  ): Either<ConflictError, void> {
    // Writing off what has expired is the reason the reason code `expiry` exists, so a
    // named lot whose day has gone is exactly what this movement is for.
    const gone = this.remove(
      quantity,
      picks,
      now,
      'these goods are not available to write off',
      true,
    )
    if (gone.isLeft()) return left(gone.value)
    this.recordMovement(
      'adjustment-out',
      quantity,
      this.props.averageUnitCost,
      now,
      origin,
      gone.value,
    )
    return right(undefined)
  }

  hold(quantity: Quantity, now: Date): Either<ConflictError, void> {
    if (quantity.isZero()) return left(new ConflictError('reservation quantity must be positive'))
    if (this.available(now).isLessThan(quantity))
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

  /**
   * The goods went to the customer, out of the promise they were held under.
   *
   * Which boxes go is decided here rather than when the promise was made, and it is
   * decided by the shelf: earliest date first. An expired lot is never sent — not even
   * when it is the only stock left, because the answer to "we have nothing good to send"
   * is to say so, not to send something that has gone off.
   */
  ship(
    quantity: Quantity,
    now: Date,
    origin?: MovementOrigin,
  ): Either<ConflictError, readonly LotEntry[]> {
    if (quantity.isZero() || this.props.reserved.isLessThan(quantity))
      return left(new ConflictError('shipment exceeds reserved stock'))
    const gone = this.draw(quantity, null, now, false)
    if (gone.isLeft()) return left(gone.value)
    this.props.reserved = this.props.reserved.minus(quantity)
    this.props.onHand = this.props.onHand.minus(quantity)
    this.recordMovement('shipment', quantity, this.props.averageUnitCost, now, origin, gone.value)
    return right(gone.value)
  }

  /**
   * Goods come back from a customer, into the promise they were shipped against.
   *
   * They return at the cost they left at — a return is not a purchase, so it moves no
   * average — and they go back to being held for the order, because the customer is still
   * owed them until somebody decides otherwise. Under lot tracking they go back into the
   * lots they went out in, which the caller reads off the shipment that sent them: goods
   * coming home are the same goods, and inventing a new code for them would lose the
   * very thread the tracking exists to keep.
   */
  takeBack(
    quantity: Quantity,
    now: Date,
    lots: readonly LotEntry[] | null = null,
    origin?: MovementOrigin,
  ): Either<ConflictError, void> {
    const added = this.add(quantity, lots, now)
    if (added.isLeft()) return left(added.value)
    this.props.reserved = this.props.reserved.plus(quantity)
    this.recordMovement('return-in', quantity, this.props.averageUnitCost, now, origin, added.value)
    return right(undefined)
  }

  /**
   * Goods leave stock without having been sold — a delivery sent back to its supplier.
   *
   * What was reserved for somebody else is untouchable: refusing here is what stops a
   * return from quietly cancelling a promise already made to a customer.
   */
  giveBack(
    quantity: Quantity,
    now: Date,
    picks: readonly LotPick[] | null = null,
    origin?: MovementOrigin,
  ): Either<ConflictError, void> {
    const gone = this.remove(
      quantity,
      picks,
      now,
      'these goods are no longer available to return',
      true,
    )
    if (gone.isLeft()) return left(gone.value)
    this.recordMovement(
      'adjustment-out',
      quantity,
      this.props.averageUnitCost,
      now,
      origin,
      gone.value,
    )
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
      available: this.available(this.props.updatedAt).toString(),
      averageUnitCost: cost
        ? { amount: cost.amount.toString(), currency: cost.currency.value }
        : null,
      version: this.props.version,
      updatedAt: this.props.updatedAt,
    })
  }

  /** Goods arrive and are averaged into what is already here. */
  private absorb(
    kind: 'receipt' | 'transfer-in' | 'adjustment-in',
    quantity: Quantity,
    unitCost: Money,
    now: Date,
    origin: MovementOrigin | undefined,
    lots: readonly LotEntry[] | null,
  ): Either<ConflictError, void> {
    const previousCost = this.props.averageUnitCost
    if (previousCost && !previousCost.currency.equals(unitCost.currency))
      return left(new ConflictError('movement currency differs from the balance currency'))
    const previousOnHand = this.props.onHand
    const added = this.add(quantity, lots, now)
    if (added.isLeft()) return left(added.value)
    const nextOnHand = this.props.onHand
    const previousValue = previousOnHand.micros * (previousCost?.amount ?? 0n)
    const receivedValue = quantity.micros * unitCost.amount
    const roundedAverage =
      (previousValue + receivedValue + nextOnHand.micros / 2n) / nextOnHand.micros
    this.props.averageUnitCost = Money.fromAmount(roundedAverage, unitCost.currency)
    this.recordMovement(kind, quantity, unitCost, now, origin, added.value)
    return right(undefined)
  }

  /**
   * Goods come onto the shelf, into the lots the caller named.
   *
   * An item nobody tracks must name none: a lot code on an item the workspace never asked
   * to identify is a picker answering a question nobody is going to read, and accepting
   * it would leave the book holding boxes the balance knows nothing about.
   */
  private add(
    quantity: Quantity,
    lots: readonly LotEntry[] | null,
    now: Date,
  ): Either<ConflictError, readonly LotEntry[]> {
    if (quantity.isZero()) return left(new ConflictError('movement quantity must be positive'))
    const named = lots ?? []
    if (!this.isTracked()) {
      if (named.length > 0)
        return left(new ConflictError('this item is not tracked by lot: name no lot for it'))
      this.props.onHand = this.props.onHand.plus(quantity)
      return right([])
    }
    if (named.length === 0)
      return left(new ConflictError('this item is tracked by lot: say which lot these are'))
    if (sum(named).micros !== quantity.micros)
      return left(new ConflictError('the lots named do not add up to the quantity moved'))
    const put = this.props.lots.put(named, this.props.tracking.expiry, now)
    if (put.isLeft()) return left(put.value)
    this.props.onHand = this.props.onHand.plus(quantity)
    return right(named)
  }

  /** Goods come off the shelf, after the availability rule that movement answers to. */
  private remove(
    quantity: Quantity,
    picks: readonly LotPick[] | null,
    now: Date,
    refusal: string,
    allowExpired: boolean,
  ): Either<ConflictError, readonly LotEntry[]> {
    if (quantity.isZero()) return left(new ConflictError('movement quantity must be positive'))
    // Measured against on hand less what is promised, not against what is sellable: a
    // movement that names an expired lot is entitled to it, and one that does not will be
    // refused by the book when it comes to pick.
    const free = this.props.onHand.isLessThan(this.props.reserved)
      ? Quantity.fromMicros(0n)
      : this.props.onHand.minus(this.props.reserved)
    if (free.isLessThan(quantity)) return left(new ConflictError(refusal))
    const drawn = this.draw(quantity, picks, now, allowExpired)
    if (drawn.isLeft()) return left(drawn.value)
    this.props.onHand = this.props.onHand.minus(quantity)
    return right(drawn.value)
  }

  private draw(
    quantity: Quantity,
    picks: readonly LotPick[] | null,
    now: Date,
    allowExpired: boolean,
  ): Either<ConflictError, readonly LotEntry[]> {
    if (!this.isTracked()) {
      if (picks && picks.length > 0)
        return left(new ConflictError('this item is not tracked by lot: name no lot for it'))
      return right([])
    }
    return this.props.lots.take(quantity, picks, now, allowExpired)
  }

  private recordMovement(
    kind: MovementKind,
    quantity: Quantity,
    unitCost: Money | null,
    now: Date,
    origin: MovementOrigin | undefined,
    lots: readonly LotEntry[],
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
        lots,
      }),
    )
  }
}

const sum = (entries: readonly LotEntry[]) =>
  entries.reduce((total, entry) => total.plus(entry.quantity), Quantity.fromMicros(0n))
