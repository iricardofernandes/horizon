import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { ProductionOrder } from '@/domain/entities/production-order'
import { type Money, Note, type Quantity } from '@/domain/value-objects/inventory-values'
import type { MovementOrigin } from '@/domain/value-objects/movement-origin'
import type { Clock } from '../ports/clock'
import type { InventoryScope, InventoryUnitOfWork } from '../ports/unit-of-work'
import {
  audit,
  type CommandContext,
  type Failure,
  type IdempotentContext,
  type Outcome,
  once,
} from './commands'
import { moneyOf, noteOf, quantityOf, unitsNamedOf, unitsPickedOf } from './inputs'
import { openBalance } from './manage-inventory'

/** Which boxes or units the finished goods arrive under, when the item is identified. */
interface NamedUnitsInput {
  readonly lots?:
    | readonly { code: string; expiresOn?: string | null | undefined; quantity: string }[]
    | null
    | undefined
  readonly serials?: readonly string[] | null | undefined
}

/** Every movement an order makes carries the order, which is what ties the two sides. */
const originOf = (orderId: string): MovementOrigin => ({
  reason: 'production',
  document: { type: 'production-order', id: orderId },
})

/**
 * An order to make something is opened before anybody knows what it will take.
 *
 * Opening it is a plan, not a commitment: no recipe is frozen, no material moves, and
 * abandoning it costs nothing. That happens at release.
 */
export class OpenProductionOrderUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    itemId: string
    warehouseId: string
    quantity: string
    note?: string | null | undefined
  }): Outcome<{ orderId: string; status: string }> {
    const { context } = request
    const quantity = quantityOf(request.quantity)
    if (quantity.isLeft()) return Promise.resolve(left(quantity.value))
    const note = noteOf(request.note)
    if (note.isLeft()) return Promise.resolve(left(note.value))

    return once(this.unitOfWork, context, 'open-production-order', request, async (scope) => {
      const warehouse = await scope.warehouses.findById(request.warehouseId)
      if (!warehouse) return left(new ResourceNotFoundError('warehouse was not found'))
      if (!warehouse.isActive()) return left(new ConflictError('warehouse is inactive'))
      const now = this.clock.now()
      const order = ProductionOrder.open({
        tenantId: context.tenantId,
        itemId: request.itemId,
        warehouseId: request.warehouseId,
        quantity: quantity.value,
        note: note.value,
        openedBy: context.actor,
        now,
      })
      if (order.isLeft()) return left(order.value)
      await scope.production.create(order.value)
      await audit(scope, context, {
        action: 'production.opened',
        subjectType: 'production',
        subjectId: order.value.id.toString(),
        occurredAt: now,
        details: {
          itemId: request.itemId,
          warehouseId: request.warehouseId,
          quantity: quantity.value.toString(),
        },
      })
      return right({ orderId: order.value.id.toString(), status: order.value.status() })
    })
  }
}

/**
 * The recipe is frozen onto the order and the floor may start drawing material.
 *
 * Frozen, not referenced: a recipe that changed halfway through would leave nobody able
 * to say what this batch was supposed to contain. What is written down is the recipe
 * already multiplied out for this order's quantity, so a later reader needs neither.
 *
 * Only an `assembled` recipe is released. An `exploded` one says the parent is never
 * stocked at all, which is a bundle somebody sells rather than a thing anybody makes.
 */
export class ReleaseProductionOrderUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    orderId: string
    /** The day whose recipe applies; today unless somebody says otherwise. */
    on?: string | null | undefined
  }): Outcome<{ status: string; version: number }> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const order = await scope.production.findById(request.orderId)
      if (!order) return left(new ResourceNotFoundError('production order was not found'))
      const on = request.on ?? this.clock.now().toISOString().slice(0, 10)
      const recipe = await scope.compositions.inForce(order.itemId(), on)
      if (!recipe)
        return left(new ResourceNotFoundError('a recipe for this item in force on that day'))
      if (recipe.realisation !== 'assembled')
        return left(new ConflictError('this item is a bundle rather than something anybody makes'))

      const now = this.clock.now()
      const released = order.release(
        { version: recipe.version, components: recipe.components },
        now,
      )
      if (released.isLeft()) return left(released.value)
      await scope.production.save(order)
      await audit(scope, context, {
        action: 'production.released',
        subjectType: 'production',
        subjectId: request.orderId,
        occurredAt: now,
        details: {
          compositionVersion: recipe.version,
          components: order.components().map((component) => ({
            itemId: component.itemId,
            expected: component.expected.toString(),
          })),
        },
      })
      return right({ status: order.status(), version: recipe.version })
    })
  }
}

/**
 * Material leaves the shelf for the order, at what it was worth there.
 *
 * The cost that leaves is the cost that will come back in the finished goods: a warehouse
 * that valued its output any other way would be inventing or destroying money between two
 * shelves of the same building.
 */
export class IssueMaterialUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    orderId: string
    itemId: string
    quantity: string
    lots?: readonly { code: string; quantity: string }[] | null | undefined
    serials?: readonly string[] | null | undefined
  }): Outcome<{ issued: string }> {
    const { context } = request
    const quantity = quantityOf(request.quantity)
    if (quantity.isLeft()) return Promise.resolve(left(quantity.value))
    const picked = unitsPickedOf(request)
    if (picked.isLeft()) return Promise.resolve(left(picked.value))

    return once(this.unitOfWork, context, 'issue-material', request, async (scope) => {
      const order = await scope.production.findById(request.orderId)
      if (!order) return left(new ResourceNotFoundError('production order was not found'))
      const balance = await scope.balances.lock(request.itemId, order.warehouseId())
      if (!balance)
        return left(new ResourceNotFoundError('this warehouse holds none of this material'))

      const now = this.clock.now()
      const gone = balance.consume(quantity.value, originOf(request.orderId), now, picked.value)
      if (gone.isLeft()) return left(gone.value)
      const issued = order.issue(request.itemId, quantity.value, gone.value.cost, now)
      if (issued.isLeft()) return left(issued.value)

      await scope.balances.save(balance)
      for (const event of balance.pullDomainEvents()) await scope.events.append(event)
      await scope.production.save(order)
      await audit(scope, context, {
        action: 'production.material-issued',
        subjectType: 'production',
        subjectId: request.orderId,
        occurredAt: now,
        details: { itemId: request.itemId, quantity: quantity.value.toString() },
      })
      return right({ issued: quantity.value.toString() })
    })
  }
}

/**
 * Part of what was issued was ruined rather than becoming product.
 *
 * Nothing moves: the material left the shelf when it was issued, and this is the order
 * saying where what it took actually went. It is what stops the finished goods from
 * carrying the cost of material that never reached them.
 */
export class ScrapMaterialUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    orderId: string
    itemId: string
    quantity: string
  }): Outcome<{ scrapped: string }> {
    const { context } = request
    const quantity = quantityOf(request.quantity)
    if (quantity.isLeft()) return Promise.resolve(left(quantity.value))

    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const order = await scope.production.findById(request.orderId)
      if (!order) return left(new ResourceNotFoundError('production order was not found'))
      const now = this.clock.now()
      const scrapped = order.scrap(request.itemId, quantity.value, now)
      if (scrapped.isLeft()) return left(scrapped.value)
      await scope.production.save(order)
      await audit(scope, context, {
        action: 'production.material-scrapped',
        subjectType: 'production',
        subjectId: request.orderId,
        occurredAt: now,
        details: { itemId: request.itemId, quantity: quantity.value.toString() },
      })
      return right({ scrapped: quantity.value.toString() })
    })
  }
}

/** What the making cost beyond the material: labour, energy, or a subcontractor's bill. */
export class ChargeProductionUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    orderId: string
    amount: string
    currency: string
    subcontractorPartyId?: string | null | undefined
  }): Outcome<{ conversionCost: string }> {
    const { context } = request
    const cost = moneyOf(request.amount, request.currency, '/amount')
    if (cost.isLeft()) return Promise.resolve(left(cost.value))

    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const order = await scope.production.findById(request.orderId)
      if (!order) return left(new ResourceNotFoundError('production order was not found'))
      const now = this.clock.now()
      const charged = order.charge(cost.value, request.subcontractorPartyId ?? null, now)
      if (charged.isLeft()) return left(charged.value)
      await scope.production.save(order)
      await audit(scope, context, {
        action: 'production.charged',
        subjectType: 'production',
        subjectId: request.orderId,
        occurredAt: now,
        details: {
          amount: cost.value.amount.toString(),
          currency: cost.value.currency.value,
          subcontractorPartyId: request.subcontractorPartyId ?? null,
        },
      })
      return right({ conversionCost: cost.value.amount.toString() })
    })
  }
}

/**
 * The goods are made, and what they are worth follows from what went into them.
 *
 * The finished unit cost is not asked for and cannot be stated: it is everything issued,
 * less everything ruined, plus what the work cost, divided by how many came out. An order
 * that let somebody name a different figure would be an order that could create money.
 */
export class FinishProductionOrderUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    orderId: string
    produced: string
    lots?:
      | readonly { code: string; expiresOn?: string | null | undefined; quantity: string }[]
      | null
      | undefined
    serials?: readonly string[] | null | undefined
  }): Outcome<{ status: string; produced: string; unitCost: string | null }> {
    const { context } = request
    const produced = quantityOf(request.produced, '/produced')
    if (produced.isLeft()) return Promise.resolve(left(produced.value))

    return once(this.unitOfWork, context, 'finish-production-order', request, async (scope) => {
      const order = await scope.production.findById(request.orderId)
      if (!order) return left(new ResourceNotFoundError('production order was not found'))
      const now = this.clock.now()
      const finished = order.finish(produced.value, now)
      if (finished.isLeft()) return left(finished.value)

      if (!produced.value.isZero()) {
        const received = await this.receive(
          scope,
          order,
          produced.value,
          finished.value.unitCost,
          request,
          now,
        )
        if (received.isLeft()) return left(received.value)
      }
      await scope.production.save(order)
      await audit(scope, context, {
        action: 'production.finished',
        subjectType: 'production',
        subjectId: request.orderId,
        occurredAt: now,
        details: {
          produced: produced.value.toString(),
          unitCost: finished.value.unitCost?.amount.toString() ?? null,
          issuedValue: order.issuedValue()?.amount.toString() ?? null,
          scrappedValue: order.scrappedValue()?.amount.toString() ?? null,
        },
      })
      return right({
        status: order.status(),
        produced: produced.value.toString(),
        unitCost: finished.value.unitCost?.amount.toString() ?? null,
      })
    })
  }

  /** The finished goods onto the shelf, worth exactly what the order says they are. */
  private async receive(
    scope: InventoryScope,
    order: ProductionOrder,
    produced: Quantity,
    unitCost: Money | null,
    request: NamedUnitsInput,
    now: Date,
  ): Promise<Either<Failure, void>> {
    if (!unitCost)
      return left(new ConflictError('nothing this order took had a cost, so what it made has none'))
    const named = unitsNamedOf(request)
    if (named.isLeft()) return left(named.value)
    const existing = await scope.balances.lock(order.itemId(), order.warehouseId())
    const balance =
      existing ??
      (await openBalance(scope, { itemId: order.itemId(), warehouseId: order.warehouseId() }, now))
    const made = balance.produce(
      produced,
      unitCost,
      originOf(order.id.toString()),
      now,
      named.value,
    )
    if (made.isLeft()) return left(made.value)
    if (existing) await scope.balances.save(balance)
    else await scope.balances.create(balance)
    for (const event of balance.pullDomainEvents()) await scope.events.append(event)
    return right(undefined)
  }
}

/** Abandoned before anything was drawn. An order that has taken material is finished. */
export class CancelProductionOrderUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    orderId: string
    reason: string
  }): Outcome<{ status: string }> {
    const { context } = request
    const reason = Note.create(request.reason, '/reason')
    if (reason.isLeft()) return Promise.resolve(left(reason.value))

    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const order = await scope.production.findById(request.orderId)
      if (!order) return left(new ResourceNotFoundError('production order was not found'))
      const now = this.clock.now()
      const cancelled = order.cancel(reason.value, now)
      if (cancelled.isLeft()) return left(cancelled.value)
      await scope.production.save(order)
      await audit(scope, context, {
        action: 'production.cancelled',
        subjectType: 'production',
        subjectId: request.orderId,
        occurredAt: now,
        details: { reason: reason.value.value },
      })
      return right({ status: order.status() })
    })
  }
}
