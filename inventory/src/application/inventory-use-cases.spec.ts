import { randomUUID } from 'node:crypto'
import { InMemoryInventoryUnitOfWork } from 'test/repositories/in-memory-inventory-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { StockBalance } from '../domain/entities/stock-balance'
import { Currency, Money, Quantity } from '../domain/value-objects/inventory-values'
import type { Clock } from './ports/clock'
import { ConfirmReservationUseCase } from './use-cases/confirm-reservation'
import { ReserveStockUseCase } from './use-cases/reserve-stock'

function unwrap<T>(result: { isLeft(): boolean; value: T }): T {
  if (result.isLeft()) throw result.value
  return result.value
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing test fixture')
  return value
}

const now = new Date('2026-09-14T20:00:00.000Z')
const clock: Clock = { now: () => now }
const quantity = (value: string) => unwrap(Quantity.create(value))
const currency = unwrap(Currency.create('BRL'))
const money = (value: string) => unwrap(Money.create(value, currency))

function stockedBalance(tenantId: string, itemId: string, warehouseId: string, amount: string) {
  const balance = StockBalance.open({ tenantId, itemId, warehouseId, now })
  unwrap(balance.receive(quantity(amount), money('100'), now))
  balance.pullDomainEvents()
  return balance
}

describe('inventory application', () => {
  it('holds every line and persists one accepted outcome atomically', async () => {
    const unitOfWork = new InMemoryInventoryUnitOfWork()
    const tenantId = randomUUID()
    const warehouseId = randomUUID()
    const firstItem = randomUUID()
    const secondItem = randomUUID()
    unitOfWork.balances.push(
      stockedBalance(tenantId, firstItem, warehouseId, '10'),
      stockedBalance(tenantId, secondItem, warehouseId, '5'),
    )
    const result = await new ReserveStockUseCase(unitOfWork, clock, 900).execute({
      tenantId,
      orderId: randomUUID(),
      orderVersion: 1,
      fulfillmentWarehouseId: warehouseId,
      lines: [
        { lineId: randomUUID(), itemId: firstItem, quantity: '4' },
        { lineId: randomUUID(), itemId: secondItem, quantity: '2.5' },
      ],
    })
    if (result.isLeft()) throw result.value
    expect(result.value).toMatchObject({
      reserved: true,
      expiresAt: new Date('2026-09-14T20:15:00.000Z'),
    })
    expect(unitOfWork.balances.map((balance) => snapshotOf(balance).reserved)).toEqual(['4', '2.5'])
    expect(unitOfWork.reservations).toHaveLength(1)
    expect(unitOfWork.events.map((event) => event.eventType)).toEqual(['inventory.stock.reserved'])
  })

  it('rejects the whole order without holding lines that had stock', async () => {
    const unitOfWork = new InMemoryInventoryUnitOfWork()
    const tenantId = randomUUID()
    const warehouseId = randomUUID()
    const availableItem = randomUUID()
    const missingItem = randomUUID()
    unitOfWork.balances.push(stockedBalance(tenantId, availableItem, warehouseId, '10'))
    const result = await new ReserveStockUseCase(unitOfWork, clock, 900).execute({
      tenantId,
      orderId: randomUUID(),
      orderVersion: 1,
      fulfillmentWarehouseId: warehouseId,
      lines: [
        { lineId: randomUUID(), itemId: availableItem, quantity: '2' },
        { lineId: randomUUID(), itemId: missingItem, quantity: '1' },
      ],
    })
    if (result.isLeft()) throw result.value
    expect(result.value).toEqual({
      reserved: false,
      shortfalls: [
        {
          lineId: expect.any(String),
          itemId: missingItem,
          requestedQuantity: '1',
          availableQuantity: '0',
        },
      ],
    })
    expect(snapshotOf(required(unitOfWork.balances[0])).reserved).toBe('0')
    expect(unitOfWork.reservations).toHaveLength(0)
    expect(unitOfWork.events[0]?.payloadOf()).toMatchObject({
      orderVersion: 1,
      shortfalls: [{ itemId: missingItem, quantity: '1', availableQuantity: '0' }],
    })
  })

  it('rejects malformed, empty and duplicate-item requests before locking', async () => {
    const unitOfWork = new InMemoryInventoryUnitOfWork()
    const useCase = new ReserveStockUseCase(unitOfWork, clock, 900)
    const base = {
      tenantId: randomUUID(),
      orderId: randomUUID(),
      orderVersion: 1,
      fulfillmentWarehouseId: randomUUID(),
    }
    expect((await useCase.execute({ ...base, lines: [] })).isLeft()).toBe(true)
    expect((await useCase.execute({ ...base, orderVersion: 0, lines: [] })).isLeft()).toBe(true)
    expect(
      (
        await useCase.execute({
          ...base,
          lines: [{ lineId: randomUUID(), itemId: randomUUID(), quantity: '0' }],
        })
      ).isLeft(),
    ).toBe(true)
    const itemId = randomUUID()
    expect(
      (
        await useCase.execute({
          ...base,
          lines: [
            { lineId: randomUUID(), itemId, quantity: '1' },
            { lineId: randomUUID(), itemId, quantity: '1' },
          ],
        })
      ).isLeft(),
    ).toBe(true)
    expect(() => new ReserveStockUseCase(unitOfWork, clock, 0)).toThrow(
      'reservation TTL must be a positive safe integer',
    )
  })

  it('turns a confirmed reservation into one shipment movement per line', async () => {
    const unitOfWork = new InMemoryInventoryUnitOfWork()
    const tenantId = randomUUID()
    const warehouseId = randomUUID()
    const itemId = randomUUID()
    const balance = stockedBalance(tenantId, itemId, warehouseId, '10')
    unitOfWork.balances.push(balance)
    const orderId = randomUUID()
    const reserved = await new ReserveStockUseCase(unitOfWork, clock, 900).execute({
      tenantId,
      orderId,
      orderVersion: 1,
      fulfillmentWarehouseId: warehouseId,
      lines: [{ lineId: randomUUID(), itemId, quantity: '4' }],
    })
    if (reserved.isLeft() || !reserved.value.reserved) throw new Error('fixture was not reserved')
    unitOfWork.events.length = 0

    const confirmed = await new ConfirmReservationUseCase(unitOfWork, clock).execute({
      tenantId,
      orderId,
      orderVersion: 2,
      reservationId: reserved.value.reservationId,
    })
    expect(confirmed.isRight()).toBe(true)
    expect(snapshotOf(balance)).toMatchObject({ onHand: '6', reserved: '0', available: '6' })
    expect(snapshotOf(required(unitOfWork.reservations[0]))).toMatchObject({
      status: 'confirmed',
      orderVersion: 2,
    })
    expect(unitOfWork.events.map((event) => event.eventType)).toEqual(['inventory.stock.moved'])
  })

  it('does not confirm the wrong or stale reservation', async () => {
    const unitOfWork = new InMemoryInventoryUnitOfWork()
    const missing = await new ConfirmReservationUseCase(unitOfWork, clock).execute({
      tenantId: randomUUID(),
      orderId: randomUUID(),
      orderVersion: 2,
      reservationId: randomUUID(),
    })
    expect(missing.isLeft()).toBe(true)

    const tenantId = randomUUID()
    const warehouseId = randomUUID()
    const itemId = randomUUID()
    unitOfWork.balances.push(stockedBalance(tenantId, itemId, warehouseId, '1'))
    const orderId = randomUUID()
    const reserved = await new ReserveStockUseCase(unitOfWork, clock, 900).execute({
      tenantId,
      orderId,
      orderVersion: 1,
      fulfillmentWarehouseId: warehouseId,
      lines: [{ lineId: randomUUID(), itemId, quantity: '1' }],
    })
    if (reserved.isLeft() || !reserved.value.reserved) throw new Error('fixture was not reserved')
    const stale = await new ConfirmReservationUseCase(unitOfWork, clock).execute({
      tenantId,
      orderId,
      orderVersion: 1,
      reservationId: reserved.value.reservationId,
    })
    expect(stale.isLeft()).toBe(true)
    expect(snapshotOf(required(unitOfWork.balances[0]))).toMatchObject({
      onHand: '1',
      reserved: '1',
    })
  })
})
