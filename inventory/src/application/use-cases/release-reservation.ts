import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { StockBalance } from '@/domain/entities/stock-balance'
import type { ReservationEventLine } from '@/domain/events/inventory-events'
import type { Clock } from '../ports/clock'
import type { InventoryScope, InventoryUnitOfWork } from '../ports/unit-of-work'

export interface ReleaseReservationRequest {
  readonly tenantId: string
  readonly orderId: string
  readonly orderVersion: number
  readonly reason: 'cancelled' | 'expired'
}

export class ReleaseReservationUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: ReleaseReservationRequest): Promise<Either<ConflictError, void>> {
    return this.unitOfWork.inTenant(request.tenantId, (scope) =>
      this.executeInScope(scope, request),
    )
  }

  async executeInScope(
    scope: InventoryScope,
    request: ReleaseReservationRequest,
  ): Promise<Either<ConflictError, void>> {
    const reservation = await scope.reservations.findByOrderId(request.orderId)
    if (!reservation) return right(undefined)
    const balances = await Promise.all(
      reservation.lines().map((line) => scope.balances.lock(line.itemId, line.warehouseId)),
    )
    if (balances.some((balance) => balance === null))
      return left(new ConflictError('a reserved balance no longer exists'))
    const now = this.clock.now()
    const released = reservation.release(request.reason, request.orderVersion, now)
    if (released.isLeft()) return left(released.value)
    await this.releaseBalances(scope, reservation.lines(), balances, now)
    await scope.reservations.save(reservation)
    for (const event of reservation.pullDomainEvents()) await scope.events.append(event)
    return right(undefined)
  }

  private async releaseBalances(
    scope: InventoryScope,
    lines: readonly ReservationEventLine[],
    balances: readonly (StockBalance | null)[],
    now: Date,
  ): Promise<void> {
    for (const [index, line] of lines.entries()) {
      const balance = balances[index]
      if (!balance) throw new Error('locked balance disappeared inside its transaction')
      const released = balance.release(line.quantity, now)
      if (released.isLeft()) throw new Error('reserved balance changed inside its transaction')
      await scope.balances.save(balance)
    }
  }
}
