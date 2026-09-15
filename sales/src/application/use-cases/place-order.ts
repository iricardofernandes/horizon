import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { SalesOrder } from '@/domain/entities/sales-order'
import type { RequestedOrderLine } from '@/domain/events/sales-events'
import { Quantity } from '@/domain/value-objects/sales-values'
import type { Clock } from '../ports/clock'
import type { SalesUnitOfWork } from '../ports/unit-of-work'

export class PlaceOrderUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    tenantId: string
    customerId: string
    fulfillmentWarehouseId: string
    lines: readonly { lineId: string; itemId: string; quantity: string }[]
  }): Promise<Either<InvalidInputError | ConflictError, { orderId: string }>> {
    const lines: RequestedOrderLine[] = []
    for (const [index, line] of request.lines.entries()) {
      const quantity = Quantity.create(line.quantity, `/lines/${index}/quantity`)
      if (quantity.isLeft()) return left(quantity.value)
      lines.push({ lineId: line.lineId, itemId: line.itemId, quantity: quantity.value })
    }
    const order = SalesOrder.draft({
      tenantId: request.tenantId,
      customerId: request.customerId,
      fulfillmentWarehouseId: request.fulfillmentWarehouseId,
      lines,
      now: this.clock.now(),
    })
    if (order.isLeft()) return left(order.value)
    const placed = order.value.place(this.clock.now())
    if (placed.isLeft()) return left(placed.value)
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      await scope.orders.create(order.value)
      for (const event of order.value.pullDomainEvents()) await scope.events.append(event)
      return right({ orderId: order.value.id.toString() })
    })
  }
}
