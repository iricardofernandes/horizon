import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import { InMemoryInventoryUnitOfWork } from 'test/repositories/in-memory-inventory-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { beforeEach, describe, expect, it } from 'vitest'
import { InventorySalesEventHandlers } from './consume-sales-events'
import { DefineItemTrackingUseCase } from './use-cases/define-policies'
import { CreateWarehouseUseCase, ReceiveStockUseCase } from './use-cases/manage-inventory'
import { ReturnToStockUseCase, ShipReservationUseCase } from './use-cases/ship-reservation'

const now = new Date('2026-09-30T12:00:00.000Z')
const clock = { now: () => now }
const ship = new ShipReservationUseCase(clock)
const takeBack = new ReturnToStockUseCase(clock)

let unitOfWork: InMemoryInventoryUnitOfWork
let handlers: InventorySalesEventHandlers
let tenantId: string
let warehouseId: string
let itemId: string

beforeEach(async () => {
  unitOfWork = new InMemoryInventoryUnitOfWork()
  handlers = new InventorySalesEventHandlers(unitOfWork, clock, 900)
  tenantId = randomUUID()
  itemId = randomUUID()
  const warehouse = await new CreateWarehouseUseCase(unitOfWork, clock).execute({
    tenantId,
    name: 'Principal',
  })
  if (warehouse.isLeft()) throw warehouse.value
  warehouseId = warehouse.value.warehouseId
})

function envelope(eventType: string, payload: unknown): EventEnvelope {
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

async function handle(event: EventEnvelope) {
  const handler = handlers.handlers[event.eventType]
  if (!handler) throw new Error(`no handler for ${event.eventType}`)
  await handler(event)
}

/** Ten on the shelf: plain, in two lots of five, or as ten named units. */
async function stock(kind: 'none' | 'lot' | 'serial') {
  if (kind !== 'none') {
    const defined = await new DefineItemTrackingUseCase(unitOfWork, clock).execute({
      context: { tenantId, actor: 'user-keeper', requestId: null },
      itemId,
      tracking: kind,
      expiry: kind === 'lot' ? 'optional' : 'none',
    })
    if (defined.isLeft()) throw defined.value
  }
  const received = await new ReceiveStockUseCase(unitOfWork, clock).execute({
    tenantId,
    warehouseId,
    itemId,
    quantity: '10',
    unitCost: '1000',
    currency: 'BRL',
    lots:
      kind === 'lot'
        ? [
            { code: 'L-A', quantity: '5' },
            { code: 'L-B', quantity: '5' },
          ]
        : null,
    serials: kind === 'serial' ? Array.from({ length: 10 }, (_, index) => `SN-${index}`) : null,
  })
  if (received.isLeft()) throw received.value
}

/** An order for four, placed and confirmed, so the four are held for it. */
async function confirmedOrder() {
  const orderId = randomUUID()
  const lineId = randomUUID()
  await handle(
    envelope('sales.order.placed', {
      orderId,
      orderVersion: 1,
      customerId: randomUUID(),
      fulfillmentWarehouseId: warehouseId,
      lines: [{ lineId, itemId, quantity: '4' }],
    }),
  )
  const reservation = unitOfWork.reservations.at(-1)
  const money = { amount: '400', currency: 'BRL' }
  await handle(
    envelope('sales.order.confirmed', {
      orderId,
      orderVersion: 2,
      customerId: randomUUID(),
      reservationId: reservation?.id.toString(),
      confirmedAt: now.toISOString(),
      lines: [
        { lineId, itemId, quantity: '4', description: 'Café', unitPrice: money, lineTotal: money },
      ],
      total: money,
    }),
  )
  return { orderId, lineId }
}

const shipped = (orderId: string, lines: { lineId: string; quantity: string }[]) =>
  unitOfWork.inTenant(tenantId, (scope) => ship.executeInScope(scope, { tenantId, orderId, lines }))
const returned = (orderId: string, lines: { lineId: string; quantity: string }[]) =>
  unitOfWork.inTenant(tenantId, (scope) =>
    takeBack.executeInScope(scope, { tenantId, orderId, lines }),
  )
const shelf = () => {
  const balance = unitOfWork.balances.find((candidate) => candidate.itemId() === itemId)
  if (!balance) throw new Error('no balance')
  return snapshotOf(balance)
}

describe('a delivery leaving and coming back', () => {
  it('takes plain goods out, and back into the promise they left against', async () => {
    await stock('none')
    const { orderId, lineId } = await confirmedOrder()
    expect((await shipped(orderId, [{ lineId, quantity: '4' }])).isRight()).toBe(true)
    expect(shelf()).toMatchObject({ onHand: '6', reserved: '0' })
    expect((await returned(orderId, [{ lineId, quantity: '1' }])).isRight()).toBe(true)
    expect(shelf()).toMatchObject({ onHand: '7', reserved: '1' })
  })

  it('brings lot-tracked goods back into the lots they went out in', async () => {
    await stock('lot')
    const { orderId, lineId } = await confirmedOrder()
    expect((await shipped(orderId, [{ lineId, quantity: '4' }])).isRight()).toBe(true)
    expect((await returned(orderId, [{ lineId, quantity: '3' }])).isRight()).toBe(true)
    expect(shelf()).toMatchObject({ onHand: '9' })
  })

  it('brings named units back as themselves', async () => {
    await stock('serial')
    const { orderId, lineId } = await confirmedOrder()
    expect((await shipped(orderId, [{ lineId, quantity: '4' }])).isRight()).toBe(true)
    expect((await returned(orderId, [{ lineId, quantity: '2' }])).isRight()).toBe(true)
    expect(shelf()).toMatchObject({ onHand: '8' })
  })
})

describe('a delivery that cannot move stock', () => {
  it('is refused for an order with no reservation, or a quantity that is not a number', async () => {
    await stock('none')
    const { orderId, lineId } = await confirmedOrder()
    const unknown = await shipped(randomUUID(), [{ lineId, quantity: '1' }])
    expect(unknown.isLeft() && unknown.value.constructor.name).toBe('ResourceNotFoundError')
    const notANumber = await shipped(orderId, [{ lineId, quantity: 'lots' }])
    expect(notANumber.isLeft() && notANumber.value.constructor.name).toBe('ConflictError')
    const back = await returned(randomUUID(), [{ lineId, quantity: '1' }])
    expect(back.isLeft()).toBe(true)
  })

  it('is refused for a line the reservation does not have, or more than it holds', async () => {
    await stock('none')
    const { orderId, lineId } = await confirmedOrder()
    expect((await shipped(orderId, [{ lineId: randomUUID(), quantity: '1' }])).isLeft()).toBe(true)
    expect((await shipped(orderId, [{ lineId, quantity: '5' }])).isLeft()).toBe(true)
    expect(shelf()).toMatchObject({ onHand: '10', reserved: '4' })
  })

  it('is refused when the reserved balance is gone', async () => {
    await stock('none')
    const { orderId, lineId } = await confirmedOrder()
    unitOfWork.balances.splice(0, unitOfWork.balances.length)
    const result = await shipped(orderId, [{ lineId, quantity: '1' }])
    expect(result.isLeft() && result.value.constructor.name).toBe('ConflictError')
  })

  it('refuses more back than the order ever shipped', async () => {
    await stock('none')
    const { orderId, lineId } = await confirmedOrder()
    await shipped(orderId, [{ lineId, quantity: '2' }])
    expect((await returned(orderId, [{ lineId, quantity: '3' }])).isLeft()).toBe(true)
  })
})
