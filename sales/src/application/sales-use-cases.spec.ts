import { randomUUID } from 'node:crypto'
import { InMemorySalesUnitOfWork } from 'test/repositories/in-memory-sales-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import type { CatalogItemProjection } from '../domain/repositories/sales-repositories'
import { Currency, LineDescription, Money } from '../domain/value-objects/sales-values'
import type { Clock } from './ports/clock'
import {
  ApplyStockReservationRejectedUseCase,
  ApplyStockReservedUseCase,
} from './use-cases/apply-reservation-outcome'
import { PlaceOrderUseCase } from './use-cases/place-order'

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
const currency = unwrap(Currency.create('BRL'))

function projection(
  tenantId: string,
  itemId: string,
  amount = '1250',
  active = true,
): CatalogItemProjection {
  return {
    tenantId,
    itemId,
    description: unwrap(LineDescription.create('Coffee')),
    unitPrice: unwrap(Money.create(amount, currency)),
    active,
  }
}

async function placedFixture(unitOfWork: InMemorySalesUnitOfWork) {
  const tenantId = randomUUID()
  const itemId = randomUUID()
  const lineId = randomUUID()
  const placed = await new PlaceOrderUseCase(unitOfWork, clock).execute({
    tenantId,
    customerId: randomUUID(),
    fulfillmentWarehouseId: randomUUID(),
    lines: [{ lineId, itemId, quantity: '2' }],
  })
  if (placed.isLeft()) throw placed.value
  return { tenantId, itemId, lineId, orderId: placed.value.orderId }
}

describe('sales application', () => {
  it('creates and places an order with its outbox fact', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await placedFixture(unitOfWork)
    expect(unitOfWork.orders).toHaveLength(1)
    expect(snapshotOf(required(unitOfWork.orders[0]))).toMatchObject({
      id: fixture.orderId,
      tenantId: fixture.tenantId,
      status: 'placed',
      version: 1,
    })
    expect(unitOfWork.events[0]?.payloadOf()).toMatchObject({
      orderId: fixture.orderId,
      orderVersion: 1,
      lines: [{ lineId: fixture.lineId, itemId: fixture.itemId, quantity: '2' }],
    })
  })

  it('rejects malformed and duplicate product lines before persistence', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const useCase = new PlaceOrderUseCase(unitOfWork, clock)
    const base = {
      tenantId: randomUUID(),
      customerId: randomUUID(),
      fulfillmentWarehouseId: randomUUID(),
    }
    expect(
      (
        await useCase.execute({
          ...base,
          lines: [{ lineId: randomUUID(), itemId: randomUUID(), quantity: '-1' }],
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
    expect(unitOfWork.orders).toHaveLength(0)
  })

  it('confirms against current catalog projections and emits both durable facts', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await placedFixture(unitOfWork)
    unitOfWork.catalogItems.push(projection(fixture.tenantId, fixture.itemId))
    unitOfWork.events.length = 0
    const reservationId = randomUUID()
    const result = await new ApplyStockReservedUseCase(unitOfWork, clock).execute({
      tenantId: fixture.tenantId,
      orderId: fixture.orderId,
      orderVersion: 1,
      reservationId,
    })
    expect(result.isRight()).toBe(true)
    expect(snapshotOf(required(unitOfWork.orders[0]))).toMatchObject({
      status: 'confirmed',
      version: 2,
      reservationId,
      total: { amount: '2500', currency: 'BRL' },
    })
    expect(unitOfWork.events.map((event) => event.eventType)).toEqual([
      'sales.order.confirmed',
      'sales.invoicing.requested',
    ])
  })

  it('does not confirm without an active local catalog projection', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await placedFixture(unitOfWork)
    const useCase = new ApplyStockReservedUseCase(unitOfWork, clock)
    const missing = await useCase.execute({
      tenantId: fixture.tenantId,
      orderId: fixture.orderId,
      orderVersion: 1,
      reservationId: randomUUID(),
    })
    expect(missing.isLeft()).toBe(true)
    unitOfWork.catalogItems.push(projection(fixture.tenantId, fixture.itemId, '1250', false))
    const inactive = await useCase.execute({
      tenantId: fixture.tenantId,
      orderId: fixture.orderId,
      orderVersion: 1,
      reservationId: randomUUID(),
    })
    expect(inactive.isLeft()).toBe(true)
    expect(snapshotOf(required(unitOfWork.orders[0]))).toMatchObject({
      status: 'placed',
      version: 1,
    })
  })

  it('applies a current rejection and refuses a late outcome', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await placedFixture(unitOfWork)
    const rejected = await new ApplyStockReservationRejectedUseCase(unitOfWork, clock).execute({
      tenantId: fixture.tenantId,
      orderId: fixture.orderId,
      orderVersion: 1,
    })
    expect(rejected.isRight()).toBe(true)
    expect(snapshotOf(required(unitOfWork.orders[0]))).toMatchObject({
      status: 'rejected',
      version: 2,
    })
    unitOfWork.catalogItems.push(projection(fixture.tenantId, fixture.itemId))
    const late = await new ApplyStockReservedUseCase(unitOfWork, clock).execute({
      tenantId: fixture.tenantId,
      orderId: fixture.orderId,
      orderVersion: 1,
      reservationId: randomUUID(),
    })
    expect(late.isLeft()).toBe(true)
  })

  it('does not leak orders or projections across tenants', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await placedFixture(unitOfWork)
    unitOfWork.catalogItems.push(projection(randomUUID(), fixture.itemId))
    const result = await new ApplyStockReservedUseCase(unitOfWork, clock).execute({
      tenantId: randomUUID(),
      orderId: fixture.orderId,
      orderVersion: 1,
      reservationId: randomUUID(),
    })
    expect(result.isLeft()).toBe(true)
  })
})
