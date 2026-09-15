import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { CommercialLineInput, SalesOrder } from '@/domain/entities/sales-order'
import type { Clock } from '../ports/clock'
import type { SalesScope, SalesUnitOfWork } from '../ports/unit-of-work'

export class ApplyStockReservedUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    tenantId: string
    orderId: string
    orderVersion: number
    reservationId: string
  }): Promise<Either<ResourceNotFoundError | ConflictError, void>> {
    return this.unitOfWork.inTenant(request.tenantId, (scope) =>
      this.executeInScope(scope, request),
    )
  }

  async executeInScope(
    scope: SalesScope,
    request: { tenantId: string; orderId: string; orderVersion: number; reservationId: string },
  ): Promise<Either<ResourceNotFoundError | ConflictError, void>> {
    const order = await scope.orders.findById(request.orderId)
    if (!order) return left(new ResourceNotFoundError('sales order was not found'))
    const commercialLines = await this.commercialLines(scope, order)
    if (commercialLines.isLeft()) return left(commercialLines.value)
    const confirmed = order.confirm(
      request.orderVersion,
      request.reservationId,
      commercialLines.value,
      this.clock.now(),
    )
    if (confirmed.isLeft()) return left(confirmed.value)
    await scope.orders.save(order)
    for (const event of order.pullDomainEvents()) await scope.events.append(event)
    return right(undefined)
  }

  private async commercialLines(
    scope: SalesScope,
    order: SalesOrder,
  ): Promise<Either<ResourceNotFoundError | ConflictError, readonly CommercialLineInput[]>> {
    const lines: CommercialLineInput[] = []
    for (const requested of order.requestedLines()) {
      const item = await scope.catalogItems.findById(requested.itemId)
      if (!item) return left(new ResourceNotFoundError('catalog item projection was not found'))
      if (!item.active) return left(new ConflictError('catalog item is inactive'))
      lines.push({
        lineId: requested.lineId,
        itemId: requested.itemId,
        description: item.description,
        unitPrice: item.unitPrice,
      })
    }
    return right(lines)
  }
}

export class ApplyStockReservationRejectedUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    tenantId: string
    orderId: string
    orderVersion: number
  }): Promise<Either<ResourceNotFoundError | ConflictError, void>> {
    return this.unitOfWork.inTenant(request.tenantId, (scope) =>
      this.executeInScope(scope, request),
    )
  }

  async executeInScope(
    scope: SalesScope,
    request: { tenantId: string; orderId: string; orderVersion: number },
  ): Promise<Either<ResourceNotFoundError | ConflictError, void>> {
    const order = await scope.orders.findById(request.orderId)
    if (!order) return left(new ResourceNotFoundError('sales order was not found'))
    const rejected = order.rejectReservation(request.orderVersion, this.clock.now())
    if (rejected.isLeft()) return left(rejected.value)
    await scope.orders.save(order)
    return right(undefined)
  }
}
