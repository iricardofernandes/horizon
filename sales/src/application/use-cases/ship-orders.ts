import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { SalesOrder } from '@/domain/entities/sales-order'
import { Shipment } from '@/domain/entities/shipment'
import type { ShippedLine } from '@/domain/services/fulfilment'
import {
  BusinessDate,
  CarrierName,
  Money,
  Quantity,
  Reason,
  TrackingCode,
} from '@/domain/value-objects/sales-values'
import type { Clock } from '../ports/clock'
import type { SalesScope, SalesUnitOfWork } from '../ports/unit-of-work'
import {
  audit,
  type CommandContext,
  type Failure,
  type IdempotentContext,
  type Outcome,
  once,
} from './commands'

export interface ShipmentLineInput {
  readonly lineId: string
  readonly quantity: string
}

export interface ConsignmentInput {
  readonly carrier?: string | undefined
  readonly trackingCode?: string | undefined
}

/**
 * Take goods off the shelf for a customer.
 *
 * Picking is the moment the warehouse commits particular units to a particular delivery,
 * so the quantities are held against the order here rather than at dispatch: two people
 * preparing two boxes from the same order cannot both promise the same unit.
 */
export class PickShipmentUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    orderId: string
    lines: readonly ShipmentLineInput[]
  }): Outcome<{ shipmentId: string }> {
    const { context } = request
    return once(this.unitOfWork, context, 'shipment.pick', request, async (scope) => {
      const order = await scope.orders.findById(request.orderId)
      if (!order) return left(new ResourceNotFoundError('sales order was not found'))
      const lines = linesOf(request.lines)
      if (lines.isLeft()) return left(lines.value)
      const now = this.clock.now()
      const picked = order.allocate(lines.value, now)
      if (picked.isLeft()) return left(picked.value)
      const [first] = picked.value
      if (!first) return left(new ConflictError('this order has nothing to pick'))
      const shipment = Shipment.pick({
        tenantId: context.tenantId,
        orderId: order.id.toString(),
        warehouseId: order.fulfillmentWarehouseId,
        lines: picked.value,
        // What it is worth is settled when it leaves: until then the order may ship
        // something else first, and the share depends on what has already gone.
        value: Money.fromAmount(0n, first.unitPrice.currency),
        pickedBy: context.actor,
        now,
      })
      await scope.shipments.create(shipment)
      await scope.orders.save(order)
      await audit(scope, context, {
        action: 'shipment.picked',
        subjectType: 'shipment',
        subjectId: shipment.id.toString(),
        occurredAt: now,
        details: { orderId: order.id.toString(), lines: request.lines.length },
      })
      return right({ shipmentId: shipment.id.toString() })
    })
  }
}

/** The goods are in the box, and whoever is carrying them can be named. */
export class PackShipmentUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    shipmentId: string
    consignment?: ConsignmentInput | undefined
  }): Outcome<{ status: string }> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const shipment = await scope.shipments.findById(request.shipmentId)
      if (!shipment) return left(new ResourceNotFoundError('shipment was not found'))
      const consignment = consignmentOf(request.consignment)
      if (consignment.isLeft()) return left(consignment.value)
      const now = this.clock.now()
      const packed = shipment.pack(context.actor, consignment.value, now)
      if (packed.isLeft()) return left(packed.value)
      await scope.shipments.save(shipment)
      await audit(scope, context, {
        action: 'shipment.packed',
        subjectType: 'shipment',
        subjectId: shipment.id.toString(),
        occurredAt: now,
        details: { orderId: shipment.orderId, carrier: shipment.carrier?.value ?? null },
      })
      return right({ status: shipment.status })
    })
  }
}

/**
 * The goods leave.
 *
 * This is the fact the rest of the platform has been waiting for: the stock comes out of
 * its reservation, the customer owes the delivery's share of the order, and what has not
 * gone is still only expected. All three follow from this one event.
 */
export class DispatchShipmentUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    shipmentId: string
    dispatchedOn?: string | undefined
    consignment?: ConsignmentInput | undefined
  }): Outcome<{ shipmentId: string; value: string; remaining: string; complete: boolean }> {
    const { context } = request
    return once(this.unitOfWork, context, 'shipment.dispatch', request, async (scope) => {
      const found = await delivery(scope, request.shipmentId)
      if (found.isLeft()) return left(found.value)
      const { shipment, order } = found.value
      const consignment = consignmentOf(request.consignment)
      if (consignment.isLeft()) return left(consignment.value)
      const now = this.clock.now()
      const dispatchedOn = dateOf(request.dispatchedOn, '/dispatchedOn', now)
      if (dispatchedOn.isLeft()) return left(dispatchedOn.value)
      const plan = order.dispatch(
        { lines: shippedLinesOf(shipment.lines()), dispatchedOn: dispatchedOn.value },
        now,
      )
      if (plan.isLeft()) return left(plan.value)
      const gone = shipment.dispatch(
        context.actor,
        { dispatchedOn: dispatchedOn.value, ...consignment.value },
        now,
      )
      if (gone.isLeft()) return left(gone.value)
      shipment.carriedValue(plan.value.value)
      order.dispatchEvent(
        {
          shipmentId: shipment.id.toString(),
          warehouseId: shipment.warehouseId,
          carrier: shipment.carrier,
          trackingCode: shipment.trackingCode,
          dispatchedBy: context.actor,
          dispatchedOn: dispatchedOn.value,
        },
        plan.value,
        now,
      )
      await scope.shipments.save(shipment)
      await scope.orders.save(order)
      for (const event of order.pullDomainEvents()) await scope.events.append(event)
      await audit(scope, context, {
        action: 'shipment.dispatched',
        subjectType: 'shipment',
        subjectId: shipment.id.toString(),
        occurredAt: now,
        details: {
          orderId: order.id.toString(),
          value: plan.value.value.amount,
          remaining: plan.value.remaining.amount,
          complete: plan.value.complete,
        },
      })
      return right({
        shipmentId: shipment.id.toString(),
        value: plan.value.value.amount.toString(),
        remaining: plan.value.remaining.amount.toString(),
        complete: plan.value.complete,
      })
    })
  }
}

/**
 * The delivery came back.
 *
 * The goods return to stock, what they made owed is withdrawn, and the order owes them to
 * the customer again — a returned delivery is a delivery the customer is still owed. The
 * dispatch and the return both stay in the record (ADR 0042).
 */
export class ReturnShipmentUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    shipmentId: string
    reason: string
    returnedOn?: string | undefined
  }): Outcome<{ shipmentId: string; value: string; remaining: string }> {
    const { context } = request
    return once(this.unitOfWork, context, 'shipment.return', request, async (scope) => {
      const found = await delivery(scope, request.shipmentId)
      if (found.isLeft()) return left(found.value)
      const { shipment, order } = found.value
      const reason = Reason.create(request.reason)
      if (reason.isLeft()) return left(reason.value)
      const now = this.clock.now()
      const returnedOn = dateOf(request.returnedOn, '/returnedOn', now)
      if (returnedOn.isLeft()) return left(returnedOn.value)
      const undone = order.unship(shippedLinesOf(shipment.lines()), now)
      if (undone.isLeft()) return left(undone.value)
      const back = shipment.takeBack(context.actor, returnedOn.value, reason.value, now)
      if (back.isLeft()) return left(back.value)
      order.returnEvent(
        {
          shipmentId: shipment.id.toString(),
          warehouseId: shipment.warehouseId,
          carrier: shipment.carrier,
          trackingCode: shipment.trackingCode,
          returnedBy: context.actor,
          returnedOn: returnedOn.value,
          reason: reason.value,
          lines: shipment.lines(),
        },
        undone.value,
        now,
      )
      await scope.shipments.save(shipment)
      await scope.orders.save(order)
      for (const event of order.pullDomainEvents()) await scope.events.append(event)
      await audit(scope, context, {
        action: 'shipment.returned',
        subjectType: 'shipment',
        subjectId: shipment.id.toString(),
        occurredAt: now,
        details: {
          orderId: order.id.toString(),
          value: undone.value.value.amount,
          reason: reason.value.value,
        },
      })
      return right({
        shipmentId: shipment.id.toString(),
        value: undone.value.value.amount.toString(),
        remaining: undone.value.remaining.amount.toString(),
      })
    })
  }
}

/** Nothing left the warehouse, so nothing happened: the goods go back on the shelf. */
export class AbandonShipmentUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    shipmentId: string
    reason: string
  }): Outcome<{ status: string }> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const found = await delivery(scope, request.shipmentId)
      if (found.isLeft()) return left(found.value)
      const { shipment, order } = found.value
      const reason = Reason.create(request.reason)
      if (reason.isLeft()) return left(reason.value)
      const now = this.clock.now()
      const abandoned = shipment.abandon(reason.value, now)
      if (abandoned.isLeft()) return left(abandoned.value)
      const released = order.releaseAllocation(shippedLinesOf(shipment.lines()), now)
      if (released.isLeft()) return left(released.value)
      await scope.shipments.save(shipment)
      await scope.orders.save(order)
      await audit(scope, context, {
        action: 'shipment.abandoned',
        subjectType: 'shipment',
        subjectId: shipment.id.toString(),
        occurredAt: now,
        details: { orderId: order.id.toString(), reason: reason.value.value },
      })
      return right({ status: shipment.status })
    })
  }
}

function linesOf(inputs: readonly ShipmentLineInput[]): Either<Failure, readonly ShippedLine[]> {
  const lines: ShippedLine[] = []
  for (const [index, input] of inputs.entries()) {
    const quantity = Quantity.create(input.quantity, `/lines/${index}/quantity`)
    if (quantity.isLeft()) return left(quantity.value)
    lines.push({ lineId: input.lineId, quantity: quantity.value })
  }
  return right(lines)
}

function shippedLinesOf(lines: readonly { lineId: string; quantity: Quantity }[]): ShippedLine[] {
  return lines.map((line) => ({ lineId: line.lineId, quantity: line.quantity }))
}

/** A delivery and the order it belongs to, which every command on one needs. */
async function delivery(
  scope: SalesScope,
  shipmentId: string,
): Promise<Either<Failure, { shipment: Shipment; order: SalesOrder }>> {
  const shipment = await scope.shipments.findById(shipmentId)
  if (!shipment) return left(new ResourceNotFoundError('shipment was not found'))
  const order = await scope.orders.findById(shipment.orderId)
  if (!order) return left(new ResourceNotFoundError('sales order was not found'))
  return right({ shipment, order })
}

/** The day the warehouse says it happened, or today when nobody says otherwise. */
function dateOf(
  value: string | undefined,
  field: string,
  now: Date,
): Either<Failure, BusinessDate> {
  return value ? BusinessDate.create(value, field) : right(BusinessDate.of(now))
}

interface Consignment {
  readonly carrier: CarrierName | null
  readonly trackingCode: TrackingCode | null
}

function consignmentOf(input: ConsignmentInput | undefined): Either<Failure, Consignment> {
  const carrier: Either<Failure, CarrierName | null> = input?.carrier
    ? CarrierName.create(input.carrier)
    : right(null)
  if (carrier.isLeft()) return left(carrier.value)
  const trackingCode: Either<Failure, TrackingCode | null> = input?.trackingCode
    ? TrackingCode.create(input.trackingCode)
    : right(null)
  if (trackingCode.isLeft()) return left(trackingCode.value)
  return right({ carrier: carrier.value, trackingCode: trackingCode.value })
}
