import { type Either, left, right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Clock } from '../ports/clock'
import type { InventoryScope, InventoryUnitOfWork } from '../ports/unit-of-work'

interface ConfirmReservationRequest {
  tenantId: string
  orderId: string
  orderVersion: number
  reservationId: string
}

/**
 * The order was committed, so what is held for it is committed too.
 *
 * Confirming does **not** take the stock out: the goods are promised to this customer and
 * stay on the shelf until somebody picks them and they leave. That is what makes a partial
 * delivery possible, and what makes a reservation mean something between the two moments.
 */
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
    const confirmed = reservation.confirm(request.orderVersion, this.clock.now())
    if (confirmed.isLeft()) return left(confirmed.value)
    await scope.reservations.save(reservation)
    return right(undefined)
  }
}
