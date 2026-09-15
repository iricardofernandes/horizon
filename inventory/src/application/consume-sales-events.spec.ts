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
  it('reserves and confirms a sales order exactly once', async () => {
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
    expect(snapshotOf(fixture.stock)).toMatchObject({ onHand: '6', reserved: '0' })
    expect(snapshotOf(reservation)).toMatchObject({ status: 'confirmed', orderVersion: 2 })
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
