import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { StockBalance } from '@/domain/entities/stock-balance'
import type { ShippedLine, StockReservation } from '@/domain/entities/stock-reservation'
import { Quantity } from '@/domain/value-objects/inventory-values'
import type { Clock } from '../ports/clock'
import type { InventoryScope } from '../ports/unit-of-work'

export interface DeliveryLine {
  readonly lineId: string
  readonly quantity: string
}

export interface DeliveryRequest {
  readonly tenantId: string
  readonly orderId: string
  readonly lines: readonly DeliveryLine[]
}

type DeliveryFailure = ResourceNotFoundError | ConflictError

/**
 * Goods left for the customer, so the stock they were held as finally goes.
 *
 * Until now the units were on the shelf and spoken for. This is the movement that takes
 * them out, and it takes out exactly what left: a delivery of part of an order leaves the
 * rest held for the delivery that follows it.
 */
export class ShipReservationUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: InventoryScope,
    request: DeliveryRequest,
  ): Promise<Either<DeliveryFailure, void>> {
    const found = await load(scope, request)
    if (found.isLeft()) return left(found.value)
    const { reservation, lines } = found.value
    const now = this.clock.now()
    const dispatched = reservation.dispatch(lines, now)
    if (dispatched.isLeft()) return left(dispatched.value)
    const moved = await move(scope, reservation, lines, (balance, quantity) =>
      balance.ship(quantity, now),
    )
    if (moved.isLeft()) return left(moved.value)
    await scope.reservations.save(reservation)
    return right(undefined)
  }
}

/**
 * A delivery came back from the customer.
 *
 * The goods return to the shelf at the cost they left at, and to the promise they were
 * shipped against: the order still owes them, so they are held for it again rather than
 * becoming free stock somebody else can be sold.
 */
export class ReturnToStockUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: InventoryScope,
    request: DeliveryRequest,
  ): Promise<Either<DeliveryFailure, void>> {
    const found = await load(scope, request)
    if (found.isLeft()) return left(found.value)
    const { reservation, lines } = found.value
    const now = this.clock.now()
    const returned = reservation.takeBack(lines, now)
    if (returned.isLeft()) return left(returned.value)
    const moved = await move(scope, reservation, lines, (balance, quantity) =>
      balance.takeBack(quantity, now),
    )
    if (moved.isLeft()) return left(moved.value)
    await scope.reservations.save(reservation)
    return right(undefined)
  }
}

/** Apply one movement per delivered line, against the balance the line was held on. */
async function move(
  scope: InventoryScope,
  reservation: StockReservation,
  lines: readonly ShippedLine[],
  apply: (balance: StockBalance, quantity: Quantity) => Either<ConflictError, void>,
): Promise<Either<DeliveryFailure, void>> {
  const held = new Map(reservation.lines().map((line) => [line.lineId, line]))
  for (const line of lines) {
    const source = held.get(line.lineId)
    if (!source) return left(new ConflictError('this reservation has no such line'))
    const balance = await scope.balances.lock(source.itemId, source.warehouseId)
    if (!balance) return left(new ConflictError('a reserved balance no longer exists'))
    const outcome = apply(balance, line.quantity)
    if (outcome.isLeft()) return left(outcome.value)
    await scope.balances.save(balance)
    for (const event of balance.pullDomainEvents()) await scope.events.append(event)
  }
  return right(undefined)
}

async function load(
  scope: InventoryScope,
  request: DeliveryRequest,
): Promise<Either<DeliveryFailure, { reservation: StockReservation; lines: ShippedLine[] }>> {
  const reservation = await scope.reservations.findByOrderId(request.orderId)
  if (!reservation) return left(new ResourceNotFoundError('stock reservation was not found'))
  const lines: ShippedLine[] = []
  for (const [index, line] of request.lines.entries()) {
    const quantity = Quantity.create(line.quantity, `/lines/${index}/quantity`)
    if (quantity.isLeft()) return left(new ConflictError('a delivered quantity is not a number'))
    lines.push({ lineId: line.lineId, quantity: quantity.value })
  }
  return right({ reservation, lines })
}
