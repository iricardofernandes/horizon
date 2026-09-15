import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { StockBalance } from '@/domain/entities/stock-balance'
import type { StockReservation } from '@/domain/entities/stock-reservation'
import type { Clock } from '../ports/clock'
import type { InventoryScope, InventoryUnitOfWork } from '../ports/unit-of-work'

interface ConfirmReservationRequest {
  tenantId: string
  orderId: string
  orderVersion: number
  reservationId: string
}

export class ConfirmReservationUseCase {
  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(
    request: ConfirmReservationRequest,
  ): Promise<Either<ResourceNotFoundError | ConflictError, void>> {
    return this.unitOfWork.inTenant(request.tenantId, (scope) =>
      this.executeInScope(scope, request),
    )
  }

  async executeInScope(
    scope: InventoryScope,
    request: ConfirmReservationRequest,
  ): Promise<Either<ResourceNotFoundError | ConflictError, void>> {
    const reservation = await scope.reservations.findByOrderId(request.orderId)
    if (!reservation || reservation.id.toString() !== request.reservationId)
      return left(new ResourceNotFoundError('stock reservation was not found'))
    const balances = await Promise.all(
      reservation.lines().map((line) => scope.balances.lock(line.itemId, line.warehouseId)),
    )
    if (balances.some((balance) => balance === null))
      return left(new ConflictError('a reserved balance no longer exists'))
    const now = this.clock.now()
    const confirmed = reservation.confirm(request.orderVersion, now)
    if (confirmed.isLeft()) return left(confirmed.value)
    await this.ship(scope, reservation, balances, now)
    await scope.reservations.save(reservation)
    return right(undefined)
  }

  private async ship(
    scope: InventoryScope,
    reservation: StockReservation,
    balances: readonly (StockBalance | null)[],
    now: Date,
  ): Promise<void> {
    for (const [index, line] of reservation.lines().entries()) {
      const balance = balances[index]
      if (!balance) throw new Error('locked balance disappeared inside its transaction')
      if (balance.ship(line.quantity, now).isLeft())
        throw new Error('reserved balance changed inside its transaction')
      await scope.balances.save(balance)
      for (const event of balance.pullDomainEvents()) await scope.events.append(event)
    }
  }
}
