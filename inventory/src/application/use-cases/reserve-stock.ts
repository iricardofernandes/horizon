import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { StockBalance } from '@/domain/entities/stock-balance'
import { StockReservation } from '@/domain/entities/stock-reservation'
import {
  InventoryStockReservationRejectedEvent,
  type ReservationEventLine,
  type ReservationShortfall,
} from '@/domain/events/inventory-events'
import { Quantity } from '@/domain/value-objects/inventory-values'
import type { Clock } from '../ports/clock'
import type { InventoryScope, InventoryUnitOfWork } from '../ports/unit-of-work'

export interface ReserveStockRequest {
  readonly tenantId: string
  readonly orderId: string
  readonly orderVersion: number
  readonly fulfillmentWarehouseId: string
  readonly lines: readonly { lineId: string; itemId: string; quantity: string }[]
}

export type ReserveStockOutcome =
  | { reserved: true; reservationId: string; expiresAt: Date }
  | {
      reserved: false
      shortfalls: readonly {
        lineId: string
        itemId: string
        requestedQuantity: string
        availableQuantity: string
      }[]
    }

export class ReserveStockUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
    private readonly ttlSeconds: number,
  ) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
      throw new RangeError('reservation TTL must be a positive safe integer')
  }

  async execute(
    request: ReserveStockRequest,
  ): Promise<Either<InvalidInputError | ConflictError, ReserveStockOutcome>> {
    return this.unitOfWork.inTenant(request.tenantId, (scope) =>
      this.executeInScope(scope, request),
    )
  }

  async executeInScope(
    scope: InventoryScope,
    request: ReserveStockRequest,
  ): Promise<Either<InvalidInputError | ConflictError, ReserveStockOutcome>> {
    if (!Number.isSafeInteger(request.orderVersion) || request.orderVersion < 1)
      return left(new InvalidInputError('/orderVersion', 'must be a positive safe integer'))
    const parsed = this.parseLines(request)
    if (parsed.isLeft()) return left(parsed.value)
    return this.reserve(scope, request, parsed.value)
  }

  private parseLines(
    request: ReserveStockRequest,
  ): Either<InvalidInputError, readonly ReservationEventLine[]> {
    const lines: ReservationEventLine[] = []
    for (const [index, line] of request.lines.entries()) {
      const quantity = Quantity.create(line.quantity, `/lines/${index}/quantity`)
      if (quantity.isLeft()) return left(quantity.value)
      if (quantity.value.isZero())
        return left(new InvalidInputError(`/lines/${index}/quantity`, 'must be positive'))
      lines.push({
        lineId: line.lineId,
        itemId: line.itemId,
        warehouseId: request.fulfillmentWarehouseId,
        quantity: quantity.value,
      })
    }
    if (lines.length === 0)
      return left(new InvalidInputError('/lines', 'an order requires at least one line'))
    if (new Set(lines.map((line) => line.itemId)).size !== lines.length)
      return left(new InvalidInputError('/lines', 'item identifiers must be unique'))
    return right(lines)
  }

  private async reserve(
    scope: InventoryScope,
    request: ReserveStockRequest,
    lines: readonly ReservationEventLine[],
  ): Promise<Either<ConflictError, ReserveStockOutcome>> {
    if (await scope.reservations.findByOrderId(request.orderId))
      return left(new ConflictError('order already has a reservation outcome'))

    const locked = await Promise.all(
      lines.map((line) => scope.balances.lock(line.itemId, line.warehouseId)),
    )
    const shortfalls = this.shortfallsFor(lines, locked)
    const now = this.clock.now()
    if (shortfalls.length > 0) return this.reject(scope, request, shortfalls, now)

    await this.hold(scope, lines, locked, now)
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000)
    const reservation = StockReservation.accept({
      tenantId: request.tenantId,
      orderId: request.orderId,
      orderVersion: request.orderVersion,
      lines,
      expiresAt,
      now,
    })
    await scope.reservations.create(reservation)
    for (const event of reservation.pullDomainEvents()) await scope.events.append(event)
    return right({ reserved: true, reservationId: reservation.id.toString(), expiresAt })
  }

  private shortfallsFor(
    lines: readonly ReservationEventLine[],
    balances: readonly (StockBalance | null)[],
  ): readonly ReservationShortfall[] {
    return lines.flatMap((line, index) => {
      const available = balances[index]?.available() ?? Quantity.fromMicros(0n)
      return available.isLessThan(line.quantity) ? [{ ...line, availableQuantity: available }] : []
    })
  }

  private async reject(
    scope: InventoryScope,
    request: ReserveStockRequest,
    shortfalls: readonly ReservationShortfall[],
    now: Date,
  ): Promise<Either<ConflictError, ReserveStockOutcome>> {
    await scope.events.append(
      new InventoryStockReservationRejectedEvent(request.orderId, request.tenantId, now, {
        orderVersion: request.orderVersion,
        shortfalls,
      }),
    )
    return right({
      reserved: false,
      shortfalls: shortfalls.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        requestedQuantity: line.quantity.toString(),
        availableQuantity: line.availableQuantity.toString(),
      })),
    })
  }

  private async hold(
    scope: InventoryScope,
    lines: readonly ReservationEventLine[],
    balances: readonly (StockBalance | null)[],
    now: Date,
  ): Promise<void> {
    for (const [index, line] of lines.entries()) {
      const balance = balances[index]
      if (!balance) throw new Error('locked balance disappeared inside its transaction')
      if (balance.hold(line.quantity, now).isLeft())
        throw new Error('locked balance changed inside its transaction')
      await scope.balances.save(balance)
    }
  }
}
