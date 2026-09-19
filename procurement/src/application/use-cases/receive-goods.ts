import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { GoodsReceipt } from '@/domain/entities/goods-receipt'
import type { ReceivedLine } from '@/domain/services/receiving'
import { Quantity, type Reason } from '@/domain/value-objects/procurement-values'
import type { Clock } from '../ports/clock'
import type { ProcurementUnitOfWork } from '../ports/unit-of-work'
import {
  audit,
  type CommandContext,
  type Failure,
  type IdempotentContext,
  type Outcome,
  once,
} from './commands'
import { dateOf, memoOf, reasonOf } from './inputs'

export interface DeliveryInput {
  readonly orderId: string
  readonly receivedOn: string
  readonly lines: readonly { readonly lineId: string; readonly quantity: string }[]
  readonly notes?: string | undefined
  /** Required to accept more than was ordered; absent otherwise. */
  readonly overrideReason?: string | undefined
}

/**
 * Take delivery against a purchase order.
 *
 * Everything the delivery starts — the stock movement in `inventory/` and the payable in
 * `financial/` — follows from the one event this publishes, so the goods and the money can
 * never disagree about what arrived. It is keyed by an idempotency key because a retried
 * request must not receive the same goods twice.
 */
export class ReceiveGoodsUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    delivery: DeliveryInput
  }): Outcome<{ id: string; value: string; complete: boolean }> {
    const { context, delivery } = request
    const receivedOn = dateOf(delivery.receivedOn, '/receivedOn')
    if (receivedOn.isLeft()) return left(receivedOn.value)
    const notes = memoOf(delivery.notes)
    if (notes.isLeft()) return left(notes.value)
    const override = parseOverride(delivery.overrideReason)
    if (override.isLeft()) return left(override.value)
    const lines = parseLines(delivery.lines)
    if (lines.isLeft()) return left(lines.value)

    return once(this.unitOfWork, context, 'goods.receive', delivery, async (scope) => {
      const order = await scope.orders.findForUpdate(delivery.orderId)
      if (!order) return left(new ResourceNotFoundError('purchase order was not found'))
      const now = this.clock.now()
      const plan = order.receive(
        { receivedOn: receivedOn.value, lines: lines.value, override: override.value },
        now,
      )
      if (plan.isLeft()) return left(plan.value)

      const receiptId = new UniqueEntityID()
      const receipt = GoodsReceipt.record(
        {
          tenantId: context.tenantId,
          orderId: delivery.orderId,
          warehouseId: order.warehouseId,
          receivedOn: receivedOn.value,
          receivedBy: context.actor,
          currency: order.currency,
          lines: plan.value.lines,
          value: plan.value.value,
          notes: notes.value,
          overrideReason: override.value,
          now,
        },
        receiptId,
      )
      await scope.receipts.create(receipt)
      order.receiptEvent(
        receiptId.toString(),
        { receivedOn: receivedOn.value, notes: notes.value },
        plan.value,
        context.actor,
        now,
      )
      await scope.orders.save(order)
      await audit(scope, context, {
        action: 'goods.received',
        subjectType: 'receipt',
        subjectId: receiptId.toString(),
        occurredAt: now,
        details: {
          orderId: delivery.orderId,
          value: plan.value.value.amount.toString(),
          currency: order.currency.value,
          complete: plan.value.complete,
          ...(override.value === null ? {} : { overrideReason: override.value.value }),
        },
      })
      return right({
        id: receiptId.toString(),
        value: plan.value.value.amount.toString(),
        complete: plan.value.complete,
      })
    })
  }
}

/**
 * Send a delivery back.
 *
 * The receipt and the return both stay in the record; the goods leave stock again and what
 * they made owed is withdrawn, both from the one event this publishes.
 */
export class ReturnGoodsUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    receiptId: string
    reason: string
  }): Promise<Either<Failure, void>> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const reason = reasonOf(request.reason)
      if (reason.isLeft()) return left(reason.value)
      const receipt = await scope.receipts.findForUpdate(request.receiptId)
      if (!receipt) return left(new ResourceNotFoundError('delivery was not found'))
      const order = await scope.orders.findForUpdate(receipt.orderId)
      if (!order) return left(new ResourceNotFoundError('purchase order was not found'))
      const now = this.clock.now()
      const returned = receipt.giveBack(context.actor, reason.value, now)
      if (returned.isLeft()) return left(returned.value)
      const lines: ReceivedLine[] = receipt
        .lines()
        .map((line) => ({ lineId: line.lineId, quantity: line.quantity }))
      const undone = order.unreceive(lines, now)
      if (undone.isLeft()) return left(undone.value)
      await scope.receipts.save(receipt)
      order.returnEvent(
        {
          id: request.receiptId,
          lines: receipt.lines().map((line) => ({
            lineId: line.lineId,
            itemId: line.itemId,
            quantity: line.quantity.toString(),
          })),
        },
        undone.value,
        reason.value,
        context.actor,
        now,
      )
      await scope.orders.save(order)
      await audit(scope, context, {
        action: 'goods.returned',
        subjectType: 'receipt',
        subjectId: request.receiptId,
        occurredAt: now,
        details: { orderId: receipt.orderId, reason: reason.value.value },
      })
      return right(undefined)
    })
  }
}

/** Stop expecting anything more against an order, so what is still committed lapses. */
export class CloseOrderUseCase {
  constructor(
    private readonly unitOfWork: ProcurementUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    orderId: string
    reason: string
  }): Promise<Either<Failure, { status: string }>> {
    const { context } = request
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const reason = reasonOf(request.reason)
      if (reason.isLeft()) return left(reason.value)
      const order = await scope.orders.findForUpdate(request.orderId)
      if (!order) return left(new ResourceNotFoundError('purchase order was not found'))
      const now = this.clock.now()
      const closed = order.close(reason.value, now)
      if (closed.isLeft()) return left(closed.value)
      await scope.orders.save(order)
      await audit(scope, context, {
        action: 'order.closed',
        subjectType: 'order',
        subjectId: request.orderId,
        occurredAt: now,
        details: { reason: reason.value.value },
      })
      return right({ status: order.status })
    })
  }
}

function parseOverride(reason: string | undefined): Either<Failure, Reason | null> {
  if (reason === undefined) return right(null)
  const parsed = reasonOf(reason)
  return parsed.isLeft() ? left(parsed.value) : right(parsed.value)
}

function parseLines(lines: DeliveryInput['lines']): Either<Failure, readonly ReceivedLine[]> {
  const parsed: ReceivedLine[] = []
  for (const line of lines) {
    const quantity = Quantity.create(line.quantity, '/lines/quantity')
    if (quantity.isLeft()) return left(quantity.value)
    parsed.push({ lineId: line.lineId, quantity: quantity.value })
  }
  if (parsed.length === 0) return left(new ConflictError('a delivery requires at least one line'))
  return right(parsed)
}
