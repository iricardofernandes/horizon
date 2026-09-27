import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import {
  type ConfirmedOrderLine,
  SalesServiceDeliveredEvent,
  SalesServiceDeliveryCancelledEvent,
} from '../events/sales-events'
import {
  merge,
  quantityShipped,
  type ShippedLine,
  scheduleFrom,
  subtract,
} from '../services/fulfilment'
import { billDelivery, type DeliveredEntry } from '../services/service-billing'
import {
  type BusinessDate,
  type Currency,
  Money,
  type PaymentTerms,
  Quantity,
  type Reason,
} from '../value-objects/sales-values'

export const SERVICE_ORDER_STATUSES = [
  'scheduled',
  'in_progress',
  'completed',
  'accepted',
  'cancelled',
] as const
export type ServiceOrderStatus = (typeof SERVICE_ORDER_STATUSES)[number]

export const SERVICE_DELIVERY_STATUSES = ['active', 'cancelled'] as const
export type ServiceDeliveryStatus = (typeof SERVICE_DELIVERY_STATUSES)[number]

/** One recorded delivery. Its facts never change; a cancellation is recorded beside them. */
export interface ServiceDelivery {
  readonly id: string
  readonly performedOn: BusinessDate
  readonly entries: readonly DeliveredEntry[]
  readonly value: Money
  readonly deliveredBy: string
  readonly status: ServiceDeliveryStatus
  readonly cancellation: {
    readonly by: string
    readonly on: BusinessDate
    readonly reason: Reason
  } | null
  readonly createdAt: Date
}

interface ServiceOrderProps {
  tenantId: string
  customerId: string
  quoteId: string | null
  currency: Currency
  lines: readonly ConfirmedOrderLine[]
  discount: Money
  paymentTerms: PaymentTerms
  notes: string | null
  scheduledFor: BusinessDate | null
  openedOn: BusinessDate
  status: ServiceOrderStatus
  deliveries: readonly ServiceDelivery[]
  createdBy: string
  acceptedBy: string | null
  closure: Reason | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface ServiceOrderInput {
  readonly tenantId: string
  readonly customerId: string
  readonly quoteId: string | null
  readonly currency: Currency
  readonly lines: readonly ConfirmedOrderLine[]
  readonly discount: Money
  readonly paymentTerms: PaymentTerms
  readonly notes: string | null
  readonly scheduledFor: BusinessDate | null
  readonly openedOn: BusinessDate
  readonly createdBy: string
  readonly now: Date
}

/**
 * Services sold to a customer and delivered stage by stage (ADR 0056).
 *
 * It has no warehouse and never reserves anything: the work is scheduled, carried out and
 * recorded as deliveries. Each delivery is billed once, when it is recorded — that is the
 * fact Financial and Fiscal act on. A delivery that turns out not to have been provided is
 * cancelled with its reason and stays in the record, and the work it covered becomes
 * deliverable again (ADR 0042).
 */
export class ServiceOrder extends AggregateRoot<ServiceOrderProps> {
  static open(
    input: ServiceOrderInput,
    id?: UniqueEntityID,
  ): Either<InvalidInputError, ServiceOrder> {
    const checked = checkLines(input.lines, input.currency)
    if (checked.isLeft()) return left(checked.value)
    const net = netOf(input.lines, input.currency)
    if (net.isLessThan(input.discount))
      return left(new InvalidInputError('/discount', 'the discount cannot exceed the services'))
    if (input.scheduledFor?.isBefore(input.openedOn))
      return left(
        new InvalidInputError('/scheduledFor', 'a service cannot be scheduled before it is sold'),
      )
    return right(
      new ServiceOrder(
        {
          ...input,
          status: 'scheduled',
          deliveries: [],
          acceptedBy: null,
          closure: null,
          version: 1,
          createdAt: input.now,
          updatedAt: input.now,
        },
        id ?? new UniqueEntityID(),
      ),
    )
  }

  static rehydrate(props: ServiceOrderProps, id: UniqueEntityID): ServiceOrder {
    return new ServiceOrder(props, id)
  }

  get tenantId(): string {
    return this.props.tenantId
  }

  get customerId(): string {
    return this.props.customerId
  }

  get status(): ServiceOrderStatus {
    return this.props.status
  }

  get version(): number {
    return this.props.version
  }

  lines(): readonly ConfirmedOrderLine[] {
    return this.props.lines
  }

  deliveries(): readonly ServiceDelivery[] {
    return this.props.deliveries
  }

  net(): Money {
    return netOf(this.props.lines, this.props.currency)
  }

  total(): Money {
    return this.net().minus(this.props.discount)
  }

  /** What the active deliveries have billed so far. */
  billed(): Money {
    return this.active().reduce(
      (sum, delivery) => sum.plus(delivery.value),
      Money.fromAmount(0n, this.props.currency),
    )
  }

  /** Every quantity delivered and not cancelled, per line. */
  delivered(): readonly ShippedLine[] {
    return this.active().reduce<readonly ShippedLine[]>(
      (sum, delivery) => merge(sum, delivery.entries),
      [],
    )
  }

  /** The work still owed to the customer, per line. */
  outstanding(): readonly ShippedLine[] {
    const delivered = this.delivered()
    return this.props.lines.flatMap((line) => {
      const done = quantityShipped(delivered, line.lineId)
      const left = done ? line.quantity.minus(done) : line.quantity
      return left.isZero() ? [] : [{ lineId: line.lineId, quantity: left }]
    })
  }

  start(now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'scheduled')
      return left(
        new ConflictError(`a ${statusName(this.props.status)} service order cannot start`),
      )
    this.props.status = 'in_progress'
    this.touch(now)
    return right(undefined)
  }

  /**
   * Work was delivered on `performedOn`: these quantities, or everything still owed.
   *
   * The delivery is billed now, at its share of the order total, with the order's payment
   * terms dated from the day the work was performed. The one that delivers the last of the
   * work completes the order.
   */
  deliver(
    input: {
      readonly deliveryId: string
      readonly lines: readonly ShippedLine[] | 'outstanding'
      readonly performedOn: BusinessDate
      readonly today: BusinessDate
      readonly deliveredBy: string
      readonly entryId: () => string
    },
    now: Date,
  ): Either<InvalidInputError | ConflictError, ServiceDelivery> {
    if (this.props.status !== 'in_progress')
      return left(
        new ConflictError(
          `a ${statusName(this.props.status)} service order is not delivering anything`,
        ),
      )
    // `today` is the UTC day; a day more admits today in every time zone. Work recorded
    // after the fact may predate the order, so there is no lower bound (Fiscal still checks
    // the competence against the issuer's own day, E0015).
    if (input.today.plusDays(1).isBefore(input.performedOn))
      return left(new InvalidInputError('/performedOn', 'work cannot be delivered in the future'))
    const outstanding = this.outstanding()
    const lines = input.lines === 'outstanding' ? outstanding : input.lines
    const checked = checkDelivery(lines, outstanding)
    if (checked.isLeft()) return left(checked.value)
    const completes = subtract(outstanding, lines)?.length === 0
    const bill = billDelivery({
      lines: this.props.lines,
      total: this.total(),
      net: this.net(),
      billed: this.billed(),
      delivery: lines,
      completes,
      entryId: input.entryId,
    })
    if (bill.value.isZero())
      return left(new ConflictError('a delivery must bill something; this work is worth nothing'))
    const delivery: ServiceDelivery = {
      id: input.deliveryId,
      performedOn: input.performedOn,
      entries: bill.entries,
      value: bill.value,
      deliveredBy: input.deliveredBy,
      status: 'active',
      cancellation: null,
      createdAt: now,
    }
    this.props.deliveries = [...this.props.deliveries, delivery]
    if (completes) this.props.status = 'completed'
    this.touch(now)
    this.addDomainEvent(
      new SalesServiceDeliveredEvent(this.id, this.props.tenantId, now, {
        deliveryId: delivery.id,
        customerId: this.props.customerId,
        performedOn: delivery.performedOn,
        deliveredBy: delivery.deliveredBy,
        lines: delivery.entries,
        value: delivery.value,
        installments: scheduleFrom(this.props.paymentTerms, delivery.value, delivery.performedOn),
        complete: completes,
      }),
    )
    return right(delivery)
  }

  /** The customer accepted the work. It closes the order; nothing else is billed. */
  accept(actor: string, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'completed')
      return left(new ConflictError('only a completed service order can be accepted'))
    this.props.status = 'accepted'
    this.props.acceptedBy = actor
    this.touch(now)
    return right(undefined)
  }

  /**
   * The work will not be done. Delivered work is undone delivery by delivery, so that
   * every reversal names what it reverses; an order with active deliveries is not cancelled.
   */
  cancel(reason: Reason, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'scheduled' && this.props.status !== 'in_progress')
      return left(
        new ConflictError(`a ${statusName(this.props.status)} service order cannot be cancelled`),
      )
    if (this.active().length > 0)
      return left(
        new ConflictError('cancel the deliveries of this service order before the order itself'),
      )
    this.props.status = 'cancelled'
    this.props.closure = reason
    this.touch(now)
    return right(undefined)
  }

  /** A delivery was not provided after all. It stays recorded; its work is owed again. */
  cancelDelivery(
    input: {
      readonly deliveryId: string
      readonly reason: Reason
      readonly cancelledOn: BusinessDate
      readonly cancelledBy: string
    },
    now: Date,
  ): Either<ConflictError, void> {
    const index = this.props.deliveries.findIndex((delivery) => delivery.id === input.deliveryId)
    const delivery = this.props.deliveries[index]
    if (!delivery) return left(new ConflictError('this delivery is not part of the service order'))
    if (delivery.status !== 'active')
      return left(new ConflictError('this delivery is already cancelled'))
    const cancelled: ServiceDelivery = {
      ...delivery,
      status: 'cancelled',
      cancellation: { by: input.cancelledBy, on: input.cancelledOn, reason: input.reason },
    }
    this.props.deliveries = this.props.deliveries.map((entry, at) =>
      at === index ? cancelled : entry,
    )
    this.props.status = 'in_progress'
    this.props.acceptedBy = null
    this.touch(now)
    this.addDomainEvent(
      new SalesServiceDeliveryCancelledEvent(this.id, this.props.tenantId, now, {
        deliveryId: delivery.id,
        customerId: this.props.customerId,
        performedOn: delivery.performedOn,
        entryIds: delivery.entries.map((entry) => entry.entryId),
        cancelledOn: input.cancelledOn,
        reason: input.reason.value,
      }),
    )
    return right(undefined)
  }

  toSnapshot() {
    const money = (value: Money) => value.amount.toString()
    const delivered = this.delivered()
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      customerId: this.props.customerId,
      quoteId: this.props.quoteId,
      status: this.props.status,
      currency: this.props.currency.value,
      net: money(this.net()),
      discount: money(this.props.discount),
      total: money(this.total()),
      billed: money(this.billed()),
      paymentTermDays: [...this.props.paymentTerms.days],
      notes: this.props.notes,
      scheduledFor: this.props.scheduledFor?.value ?? null,
      openedOn: this.props.openedOn.value,
      createdBy: this.props.createdBy,
      acceptedBy: this.props.acceptedBy,
      closureReason: this.props.closure?.value ?? null,
      version: this.props.version,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
      lines: this.props.lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        description: line.description.value,
        quantity: line.quantity.toString(),
        delivered: (quantityShipped(delivered, line.lineId) ?? Quantity.fromMicros(0n)).toString(),
        unitPrice: money(line.unitPrice),
        lineTotal: money(line.lineTotal),
      })),
      deliveries: this.props.deliveries.map((delivery) => ({
        id: delivery.id,
        performedOn: delivery.performedOn.value,
        competence: delivery.performedOn.value.slice(0, 7),
        value: money(delivery.value),
        status: delivery.status,
        deliveredBy: delivery.deliveredBy,
        cancelledBy: delivery.cancellation?.by ?? null,
        cancelledOn: delivery.cancellation?.on.value ?? null,
        cancellationReason: delivery.cancellation?.reason.value ?? null,
        createdAt: delivery.createdAt,
        entries: delivery.entries.map((entry) => ({
          entryId: entry.entryId,
          lineId: entry.lineId,
          itemId: entry.itemId,
          description: entry.description.value,
          quantity: entry.quantity.toString(),
          unitPrice: money(entry.unitPrice),
          lineTotal: money(entry.lineTotal),
          amount: money(entry.amount),
        })),
      })),
    })
  }

  private active(): readonly ServiceDelivery[] {
    return this.props.deliveries.filter((delivery) => delivery.status === 'active')
  }

  private touch(now: Date): void {
    this.props.version += 1
    this.props.updatedAt = now
  }
}

function statusName(status: ServiceOrderStatus): string {
  return status.replace('_', '-')
}

function netOf(lines: readonly ConfirmedOrderLine[], currency: Currency): Money {
  return lines.reduce((sum, line) => sum.plus(line.lineTotal), Money.fromAmount(0n, currency))
}

function checkLines(
  lines: readonly ConfirmedOrderLine[],
  currency: Currency,
): Either<InvalidInputError, void> {
  if (lines.length === 0)
    return left(new InvalidInputError('/lines', 'a service order requires at least one line'))
  if (new Set(lines.map((line) => line.lineId)).size !== lines.length)
    return left(new InvalidInputError('/lines', 'each line appears once'))
  for (const [index, line] of lines.entries()) {
    if (line.quantity.isZero())
      return left(new InvalidInputError(`/lines/${index}/quantity`, 'must be positive'))
    if (!line.unitPrice.currency.equals(currency))
      return left(new InvalidInputError(`/lines/${index}`, 'every line is priced in one currency'))
  }
  return right(undefined)
}

function checkDelivery(
  lines: readonly ShippedLine[],
  outstanding: readonly ShippedLine[],
): Either<InvalidInputError | ConflictError, void> {
  if (lines.length === 0)
    return left(new ConflictError('nothing is left to deliver on this service order'))
  if (new Set(lines.map((line) => line.lineId)).size !== lines.length)
    return left(new InvalidInputError('/lines', 'deliver each line once, in a single row'))
  for (const line of lines) {
    if (line.quantity.isZero())
      return left(new InvalidInputError('/lines/quantity', 'delivered quantities must be positive'))
    const owed = quantityShipped(outstanding, line.lineId)
    if (!owed || owed.isLessThan(line.quantity))
      return left(
        new ConflictError(`line ${line.lineId} has less left to deliver than this delivery says`),
      )
  }
  return right(undefined)
}
