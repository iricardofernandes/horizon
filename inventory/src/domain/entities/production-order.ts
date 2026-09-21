import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { Money, type Note, Quantity } from '../value-objects/inventory-values'

export const PRODUCTION_STATUSES = ['planned', 'released', 'finished', 'cancelled'] as const
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number]

/**
 * One material the order expects to use, and what has actually happened to it.
 *
 * `issued` is what left the shelf. `scrapped` is the part of that which was ruined rather
 * than becoming product — it has already gone from stock, so this is not a second
 * movement but the order saying where what it took actually went.
 */
export interface ProductionComponent {
  readonly itemId: string
  /** What the recipe asked for, frozen when the order was released. */
  readonly expected: Quantity
  readonly issued: Quantity
  readonly issuedValue: Money | null
  readonly scrapped: Quantity
  readonly scrappedValue: Money | null
}

interface ProductionOrderProps {
  tenantId: string
  itemId: string
  warehouseId: string
  quantity: Quantity
  status: ProductionStatus
  /** The version of the recipe this order was released under, frozen against later edits. */
  compositionVersion: number | null
  components: readonly ProductionComponent[]
  produced: Quantity
  /** Labour, energy, or a subcontractor's bill: what the making cost beyond the material. */
  conversionCost: Money | null
  /** Who did the work, when it was not this company. */
  subcontractorPartyId: string | null
  note: Note | null
  openedBy: string
  openedAt: Date
  releasedAt: Date | null
  finishedAt: Date | null
  closureReason: Note | null
  updatedAt: Date
}

/**
 * An order to make something out of other things.
 *
 * The recipe is frozen when the order is released, not read when it finishes: a recipe
 * that changed halfway through would leave nobody able to say what this batch was
 * supposed to contain. What the order then actually consumed is recorded as it happens,
 * and is allowed to differ from the plan — the plan is a plan, and a warehouse that
 * refused to record what really went in would be keeping tidy books about a fiction.
 *
 * The order conserves value. Everything issued has exactly one of two fates: it became
 * product, or it was ruined. So `issued + conversion = produced + scrapped`, always, and
 * an order that produced nothing must say that everything it took was ruined — because if
 * nothing came out and nothing was scrapped, the material is simply unaccounted for.
 *
 * One level deep, deliberately. An order for a chair consumes a frame and four legs; the
 * frame is made by its own order. Exploding the whole tree into one order would hide that
 * the frames were made at a different time, at a different cost, possibly by somebody
 * else.
 */
export class ProductionOrder extends AggregateRoot<ProductionOrderProps> {
  static rehydrate(props: ProductionOrderProps, id: UniqueEntityID): ProductionOrder {
    return new ProductionOrder(props, id)
  }

  static open(
    props: {
      tenantId: string
      itemId: string
      warehouseId: string
      quantity: Quantity
      note: Note | null
      openedBy: string
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<ConflictError, ProductionOrder> {
    if (props.quantity.isZero())
      return left(new ConflictError('an order to make nothing is not an order'))
    return right(
      new ProductionOrder(
        {
          tenantId: props.tenantId,
          itemId: props.itemId,
          warehouseId: props.warehouseId,
          quantity: props.quantity,
          status: 'planned',
          compositionVersion: null,
          components: [],
          produced: Quantity.fromMicros(0n),
          conversionCost: null,
          subcontractorPartyId: null,
          note: props.note,
          openedBy: props.openedBy,
          openedAt: props.now,
          releasedAt: null,
          finishedAt: null,
          closureReason: null,
          updatedAt: props.now,
        },
        id,
      ),
    )
  }

  /**
   * The recipe is frozen and the floor may start drawing material.
   *
   * What is frozen is the recipe multiplied out for this order's quantity, so a later
   * reader does not have to know what the recipe said or how many were being made to see
   * what was supposed to go in.
   */
  release(
    recipe: { version: number; components: readonly { itemId: string; perUnit: Quantity }[] },
    now: Date,
  ): Either<ConflictError, void> {
    if (this.props.status !== 'planned')
      return left(new ConflictError('only a planned order is released'))
    if (recipe.components.length === 0)
      return left(new ConflictError('an order cannot be released against an empty recipe'))
    this.props.compositionVersion = recipe.version
    this.props.components = recipe.components.map((component) => ({
      itemId: component.itemId,
      expected: Quantity.fromMicros(
        (component.perUnit.micros * this.props.quantity.micros) / 1_000_000n,
      ),
      issued: Quantity.fromMicros(0n),
      issuedValue: null,
      scrapped: Quantity.fromMicros(0n),
      scrappedValue: null,
    }))
    this.props.status = 'released'
    this.props.releasedAt = now
    this.props.updatedAt = now
    return right(undefined)
  }

  /**
   * Material left the shelf for this order, at what it was worth there.
   *
   * More than the recipe asked for is allowed and recorded: a batch that needed an extra
   * metre of something needed it, and an order that refused to say so would leave the
   * material missing from stock with nothing to explain it.
   */
  issue(
    componentItemId: string,
    quantity: Quantity,
    unitCost: Money | null,
    now: Date,
  ): Either<ConflictError, void> {
    if (this.props.status !== 'released')
      return left(new ConflictError('only a released order takes material'))
    if (quantity.isZero()) return left(new ConflictError('an issue of nothing is not an issue'))
    const component = this.find(componentItemId)
    if (!component) return left(new ConflictError('this material is not on the order’s recipe'))
    const value = unitCost ? worth(quantity, unitCost) : null
    const added = this.addValue(component.issuedValue, value)
    if (added.isLeft()) return left(added.value)
    this.replace({
      ...component,
      issued: component.issued.plus(quantity),
      issuedValue: added.value,
    })
    this.props.updatedAt = now
    return right(undefined)
  }

  /**
   * Part of what was issued was ruined rather than becoming product.
   *
   * It left the shelf when it was issued, so nothing moves here: this is the order saying
   * where what it took actually went. Ruining more than was issued is refused, because
   * the floor cannot lose what it never had.
   */
  scrap(componentItemId: string, quantity: Quantity, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'released')
      return left(new ConflictError('only a released order records scrap'))
    if (quantity.isZero()) return left(new ConflictError('scrapping nothing is not scrapping'))
    const component = this.find(componentItemId)
    if (!component) return left(new ConflictError('this material is not on the order’s recipe'))
    const scrapped = component.scrapped.plus(quantity)
    if (component.issued.isLessThan(scrapped))
      return left(new ConflictError('more of this material was ruined than was ever issued'))
    // Valued at what the material was worth on average across everything issued of it, so
    // the part ruined and the part that became product are priced the same way.
    const unitCost = this.unitCostOf(component)
    const value = unitCost ? worth(scrapped, unitCost) : null
    this.replace({ ...component, scrapped, scrappedValue: value })
    this.props.updatedAt = now
    return right(undefined)
  }

  /** What the making cost beyond the material: labour, energy, a subcontractor's bill. */
  charge(
    conversionCost: Money,
    subcontractorPartyId: string | null,
    now: Date,
  ): Either<ConflictError, void> {
    if (this.props.status !== 'released')
      return left(new ConflictError('only a released order is charged for the work'))
    const currency = this.currency()
    if (currency && !currency.equals(conversionCost.currency))
      return left(new ConflictError('the work is charged in a currency the material is not in'))
    this.props.conversionCost = conversionCost
    this.props.subcontractorPartyId = subcontractorPartyId
    this.props.updatedAt = now
    return right(undefined)
  }

  /**
   * The goods are made, and what they are worth follows from what went into them.
   *
   * Nothing coming out is allowed — a batch can fail completely — but then everything
   * issued must have been recorded as ruined. Otherwise the material is simply
   * unaccounted for, and an order that let it be would break the only promise this
   * aggregate makes.
   */
  finish(produced: Quantity, now: Date): Either<ConflictError, { unitCost: Money | null }> {
    if (this.props.status !== 'released')
      return left(new ConflictError('only a released order is finished'))
    const issued = this.issuedValue()
    const scrapped = this.scrappedValue()
    if (produced.isZero()) {
      if (issued !== null && issued.amount !== (scrapped?.amount ?? 0n))
        return left(
          new ConflictError(
            'an order that produced nothing must account for everything it took as ruined',
          ),
        )
      this.settle(produced, now)
      return right({ unitCost: null })
    }
    const value = this.outputValue(issued, scrapped)
    this.props.produced = produced
    this.settle(produced, now)
    if (!value) return right({ unitCost: null })
    // Rounded half up, the same way the balance rounds its own average.
    const unitCost = Money.fromAmount(
      (value.amount * 1_000_000n + produced.micros / 2n) / produced.micros,
      value.currency,
    )
    return right({ unitCost })
  }

  /** Abandoned before anything was drawn; an order that has taken material is finished. */
  cancel(reason: Note, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'planned' && this.props.status !== 'released')
      return left(new ConflictError('an order that has been settled cannot be abandoned'))
    if (this.props.components.some((component) => !component.issued.isZero()))
      return left(
        new ConflictError(
          'this order has already taken material: finish it with what came out instead',
        ),
      )
    this.props.status = 'cancelled'
    this.props.closureReason = reason
    this.props.updatedAt = now
    return right(undefined)
  }

  /** What the finished goods are worth in total: what went in, less what was ruined. */
  outputValue(issued = this.issuedValue(), scrapped = this.scrappedValue()): Money | null {
    const conversion = this.props.conversionCost
    if (!issued && !conversion) return null
    const currency = (issued ?? conversion)?.currency
    if (!currency) return null
    const amount = (issued?.amount ?? 0n) - (scrapped?.amount ?? 0n) + (conversion?.amount ?? 0n)
    return Money.fromAmount(amount < 0n ? 0n : amount, currency)
  }

  issuedValue(): Money | null {
    return this.total((component) => component.issuedValue)
  }

  scrappedValue(): Money | null {
    return this.total((component) => component.scrappedValue)
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  itemId(): string {
    return this.props.itemId
  }

  warehouseId(): string {
    return this.props.warehouseId
  }

  quantity(): Quantity {
    return this.props.quantity
  }

  produced(): Quantity {
    return this.props.produced
  }

  status(): ProductionStatus {
    return this.props.status
  }

  components(): readonly ProductionComponent[] {
    return this.props.components
  }

  compositionVersion(): number | null {
    return this.props.compositionVersion
  }

  conversionCost(): Money | null {
    return this.props.conversionCost
  }

  subcontractorPartyId(): string | null {
    return this.props.subcontractorPartyId
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    itemId: string
    warehouseId: string
    quantity: string
    status: ProductionStatus
    compositionVersion: number | null
    produced: string
    conversionCost: { amount: string; currency: string } | null
    subcontractorPartyId: string | null
    note: string | null
    openedBy: string
    openedAt: Date
    releasedAt: Date | null
    finishedAt: Date | null
    closureReason: string | null
    updatedAt: Date
    components: readonly {
      itemId: string
      expected: string
      issued: string
      issuedValue: { amount: string; currency: string } | null
      scrapped: string
      scrappedValue: { amount: string; currency: string } | null
    }[]
  }> {
    const money = (value: Money | null) =>
      value ? { amount: value.amount.toString(), currency: value.currency.value } : null
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      itemId: this.props.itemId,
      warehouseId: this.props.warehouseId,
      quantity: this.props.quantity.toString(),
      status: this.props.status,
      compositionVersion: this.props.compositionVersion,
      produced: this.props.produced.toString(),
      conversionCost: money(this.props.conversionCost),
      subcontractorPartyId: this.props.subcontractorPartyId,
      note: this.props.note?.value ?? null,
      openedBy: this.props.openedBy,
      openedAt: this.props.openedAt,
      releasedAt: this.props.releasedAt,
      finishedAt: this.props.finishedAt,
      closureReason: this.props.closureReason?.value ?? null,
      updatedAt: this.props.updatedAt,
      components: this.props.components.map((component) => ({
        itemId: component.itemId,
        expected: component.expected.toString(),
        issued: component.issued.toString(),
        issuedValue: money(component.issuedValue),
        scrapped: component.scrapped.toString(),
        scrappedValue: money(component.scrappedValue),
      })),
    })
  }

  private settle(produced: Quantity, now: Date): void {
    this.props.produced = produced
    this.props.status = 'finished'
    this.props.finishedAt = now
    this.props.updatedAt = now
  }

  private find(itemId: string): ProductionComponent | undefined {
    return this.props.components.find((component) => component.itemId === itemId)
  }

  private replace(component: ProductionComponent): void {
    this.props.components = this.props.components.map((held) =>
      held.itemId === component.itemId ? component : held,
    )
  }

  /** What one of this material has cost this order on average across everything issued. */
  private unitCostOf(component: ProductionComponent): Money | null {
    if (!component.issuedValue || component.issued.isZero()) return null
    return Money.fromAmount(
      (component.issuedValue.amount * 1_000_000n + component.issued.micros / 2n) /
        component.issued.micros,
      component.issuedValue.currency,
    )
  }

  private currency() {
    return this.props.components.find((component) => component.issuedValue)?.issuedValue?.currency
  }

  private addValue(held: Money | null, added: Money | null): Either<ConflictError, Money | null> {
    if (!added) return right(held)
    if (!held) return right(added)
    if (!held.currency.equals(added.currency))
      return left(new ConflictError('this order has taken material in two currencies'))
    return right(Money.fromAmount(held.amount + added.amount, held.currency))
  }

  private total(of: (component: ProductionComponent) => Money | null): Money | null {
    let sum: Money | null = null
    for (const component of this.props.components) {
      const value = of(component)
      if (!value) continue
      sum = sum ? Money.fromAmount(sum.amount + value.amount, sum.currency) : value
    }
    return sum
  }
}

/** What a quantity of something is worth, rounded half up to the minor unit. */
function worth(quantity: Quantity, unitCost: Money): Money {
  return Money.fromAmount(
    (quantity.micros * unitCost.amount + 500_000n) / 1_000_000n,
    unitCost.currency,
  )
}
