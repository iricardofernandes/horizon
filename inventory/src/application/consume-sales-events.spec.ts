import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import { InMemoryInventoryUnitOfWork } from 'test/repositories/in-memory-inventory-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { StockBalance } from '@/domain/entities/stock-balance'
import { Currency, Money, Quantity } from '@/domain/value-objects/inventory-values'
import { InventorySalesEventHandlers } from './consume-sales-events'

function unwrap<T>(result: { isLeft(): boolean; value: T }): T {
  if (result.isLeft()) throw result.value
  return result.value
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing test fixture')
  return value
}

const now = new Date('2026-09-14T20:00:00.000Z')
const clock = { now: () => now }

function envelope(eventType: string, tenantId: string, payload: unknown): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    occurredAt: now.toISOString(),
    tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload,
  }
}

function balance(unitOfWork: InMemoryInventoryUnitOfWork) {
  const tenantId = randomUUID()
  const itemId = randomUUID()
  const warehouseId = randomUUID()
  const stock = StockBalance.open({ tenantId, itemId, warehouseId, now })
  const currency = unwrap(Currency.create('BRL'))
  unwrap(stock.receive(unwrap(Quantity.create('10')), unwrap(Money.create('100', currency)), now))
  stock.pullDomainEvents()
  unitOfWork.balances.push(stock)
  return { tenantId, itemId, warehouseId, stock }
}

async function reserve(handlers: InventorySalesEventHandlers, fixture: ReturnType<typeof balance>) {
  const orderId = randomUUID()
  const lineId = randomUUID()
  const event = envelope('sales.order.placed', fixture.tenantId, {
    orderId,
    orderVersion: 1,
    customerId: randomUUID(),
    fulfillmentWarehouseId: fixture.warehouseId,
    lines: [{ lineId, itemId: fixture.itemId, quantity: '4' }],
  })
  await required(handlers.handlers[event.eventType])(event)
  return { orderId, lineId, event }
}

describe('inventory sales event handlers', () => {
  it('holds the goods on confirmation and takes them out when they leave', async () => {
    const unitOfWork = new InMemoryInventoryUnitOfWork()
    const handlers = new InventorySalesEventHandlers(unitOfWork, clock, 900)
    const fixture = balance(unitOfWork)
    const placed = await reserve(handlers, fixture)
    await required(handlers.handlers[placed.event.eventType])(placed.event)
    expect(unitOfWork.reservations).toHaveLength(1)
    const reservation = required(unitOfWork.reservations[0])
    const confirmed = envelope('sales.order.confirmed', fixture.tenantId, {
      orderId: placed.orderId,
      orderVersion: 2,
      customerId: randomUUID(),
      reservationId: reservation.id.toString(),
      confirmedAt: now.toISOString(),
      lines: [
        {
          lineId: placed.lineId,
          itemId: fixture.itemId,
          quantity: '4',
          description: 'Coffee',
          unitPrice: { amount: '100', currency: 'BRL' },
          lineTotal: { amount: '400', currency: 'BRL' },
        },
      ],
      total: { amount: '400', currency: 'BRL' },
    })
    await required(handlers.handlers[confirmed.eventType])(confirmed)
    // Committing the order does not empty the shelf: the goods are promised, not gone.
    expect(snapshotOf(fixture.stock)).toMatchObject({ onHand: '10', reserved: '4' })
    expect(snapshotOf(reservation)).toMatchObject({ status: 'confirmed', orderVersion: 2 })

    const shipped = (quantity: string, complete: boolean) =>
      envelope('sales.shipment.dispatched', fixture.tenantId, {
        orderId: placed.orderId,
        orderVersion: 3,
        shipmentId: randomUUID(),
        customerId: randomUUID(),
        warehouseId: fixture.warehouseId,
        dispatchedBy: 'user:warehouse',
        dispatchedOn: '2026-09-14',
        carrier: null,
        trackingCode: null,
        lines: [
          {
            lineId: placed.lineId,
            itemId: fixture.itemId,
            quantity,
            description: 'Coffee',
            unitPrice: { amount: '100', currency: 'BRL' },
            lineTotal: { amount: '100', currency: 'BRL' },
          },
        ],
        value: { amount: '100', currency: 'BRL' },
        installments: [
          { number: 1, dueOn: '2026-09-14', amount: { amount: '100', currency: 'BRL' } },
        ],
        remaining: { amount: '300', currency: 'BRL' },
        remainingInstallments: [],
        complete,
      })

    // Part of the order leaves: that part comes out of stock, the rest stays held.
    const first = shipped('1', false)
    await required(handlers.handlers[first.eventType])(first)
    await required(handlers.handlers[first.eventType])(first)
    expect(snapshotOf(fixture.stock)).toMatchObject({ onHand: '9', reserved: '3' })
    expect(snapshotOf(reservation).status).toBe('confirmed')
    expect(unitOfWork.events.at(-1)?.payloadOf()).toMatchObject({ kind: 'shipment' })

    const rest = shipped('3', true)
    await required(handlers.handlers[rest.eventType])(rest)
    expect(snapshotOf(fixture.stock)).toMatchObject({ onHand: '6', reserved: '0' })
    expect(snapshotOf(reservation).status).toBe('shipped')
  })

  it('puts a returned delivery back on the shelf, and back in its promise', async () => {
    const unitOfWork = new InMemoryInventoryUnitOfWork()
    const handlers = new InventorySalesEventHandlers(unitOfWork, clock, 900)
    const fixture = balance(unitOfWork)
    const placed = await reserve(handlers, fixture)
    const reservation = required(unitOfWork.reservations[0])
    const line = {
      lineId: placed.lineId,
      itemId: fixture.itemId,
      quantity: '4',
      description: 'Coffee',
      unitPrice: { amount: '100', currency: 'BRL' },
      lineTotal: { amount: '400', currency: 'BRL' },
    }
    const confirmed = envelope('sales.order.confirmed', fixture.tenantId, {
      orderId: placed.orderId,
      orderVersion: 2,
      customerId: randomUUID(),
      reservationId: reservation.id.toString(),
      confirmedAt: now.toISOString(),
      lines: [line],
      total: { amount: '400', currency: 'BRL' },
    })
    await required(handlers.handlers[confirmed.eventType])(confirmed)
    const shipmentId = randomUUID()
    const dispatched = envelope('sales.shipment.dispatched', fixture.tenantId, {
      orderId: placed.orderId,
      orderVersion: 3,
      shipmentId,
      customerId: randomUUID(),
      warehouseId: fixture.warehouseId,
      dispatchedBy: 'user:warehouse',
      dispatchedOn: '2026-09-14',
      carrier: null,
      trackingCode: null,
      lines: [line],
      value: { amount: '400', currency: 'BRL' },
      installments: [
        { number: 1, dueOn: '2026-09-14', amount: { amount: '400', currency: 'BRL' } },
      ],
      remaining: { amount: '0', currency: 'BRL' },
      remainingInstallments: [],
      complete: true,
    })
    await required(handlers.handlers[dispatched.eventType])(dispatched)
    expect(snapshotOf(fixture.stock)).toMatchObject({ onHand: '6', reserved: '0' })

    const returned = envelope('sales.shipment.returned', fixture.tenantId, {
      orderId: placed.orderId,
      orderVersion: 4,
      shipmentId,
      customerId: randomUUID(),
      warehouseId: fixture.warehouseId,
      returnedBy: 'user:warehouse',
      returnedOn: '2026-09-16',
      reason: 'Damaged in transit',
      lines: [line],
      value: { amount: '400', currency: 'BRL' },
      remaining: { amount: '400', currency: 'BRL' },
      remainingInstallments: [],
    })
    await required(handlers.handlers[returned.eventType])(returned)
    // The customer is still owed these goods, so they come back held rather than free.
    expect(snapshotOf(fixture.stock)).toMatchObject({ onHand: '10', reserved: '4', available: '6' })
    expect(snapshotOf(reservation).status).toBe('confirmed')
    expect(unitOfWork.events.at(-1)?.payloadOf()).toMatchObject({ kind: 'return-in' })
  })

  it('releases an active hold when the order is cancelled', async () => {
    const unitOfWork = new InMemoryInventoryUnitOfWork()
    const handlers = new InventorySalesEventHandlers(unitOfWork, clock, 900)
    const fixture = balance(unitOfWork)
    const placed = await reserve(handlers, fixture)
    const cancelled = envelope('sales.order.cancelled', fixture.tenantId, {
      orderId: placed.orderId,
      orderVersion: 2,
      reservationId: null,
      cancelledAt: now.toISOString(),
      reason: 'customer request',
    })
    await required(handlers.handlers[cancelled.eventType])(cancelled)
    expect(snapshotOf(fixture.stock).reserved).toBe('0')
    expect(snapshotOf(required(unitOfWork.reservations[0]))).toMatchObject({
      status: 'released',
      orderVersion: 2,
    })
    expect(unitOfWork.events.at(-1)?.eventType).toBe('inventory.stock.released')
  })
})
