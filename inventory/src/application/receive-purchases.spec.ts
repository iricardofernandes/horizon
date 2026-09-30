import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import { InMemoryInventoryUnitOfWork } from 'test/repositories/in-memory-inventory-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { beforeEach, describe, expect, it } from 'vitest'
import { Warehouse } from '@/domain/entities/warehouse'
import { InventoryStockMovedEvent } from '@/domain/events/inventory-events'
import { WarehouseName } from '@/domain/value-objects/inventory-values'
import { InventoryCatalogEventHandlers } from './consume-catalog-events'
import { InventoryProcurementEventHandlers } from './consume-procurement-events'
import { DefineItemTrackingUseCase } from './use-cases/define-policies'
import {
  type PurchasedLine,
  ReceivePurchasedGoodsUseCase,
  ReturnPurchasedGoodsUseCase,
} from './use-cases/receive-purchases'

const now = new Date('2026-09-30T12:00:00.000Z')
const clock = { now: () => now }
const receive = new ReceivePurchasedGoodsUseCase(clock)
const giveBack = new ReturnPurchasedGoodsUseCase(clock)

let unitOfWork: InMemoryInventoryUnitOfWork
let tenantId: string
let warehouseId: string
let itemId: string

function warehouse(active = true): string {
  const name = WarehouseName.create('Principal')
  if (name.isLeft()) throw name.value
  const created = Warehouse.create({ tenantId, name: name.value, now, active })
  unitOfWork.warehouses.push(created)
  return created.id.toString()
}

beforeEach(() => {
  unitOfWork = new InMemoryInventoryUnitOfWork()
  tenantId = randomUUID()
  itemId = randomUUID()
  warehouseId = warehouse()
})

const line = (overrides: Partial<PurchasedLine> = {}): PurchasedLine => ({
  itemId,
  quantity: '5',
  unitPrice: { amount: '1200', currency: 'BRL' },
  ...overrides,
})

const received = (lines: readonly PurchasedLine[], target = warehouseId, receiptId?: string) =>
  unitOfWork.inTenant(tenantId, (scope) =>
    receive.executeInScope(scope, { tenantId, warehouseId: target, receiptId, lines }),
  )

const returned = (
  lines: Parameters<ReturnPurchasedGoodsUseCase['executeInScope']>[1]['lines'],
  receiptId?: string,
) =>
  unitOfWork.inTenant(tenantId, (scope) =>
    giveBack.executeInScope(scope, { tenantId, warehouseId, receiptId, lines }),
  )

async function tracked(kind: 'lot' | 'serial') {
  const defined = await new DefineItemTrackingUseCase(unitOfWork, clock).execute({
    context: { tenantId, actor: 'user-keeper', requestId: null },
    itemId,
    tracking: kind,
    expiry: kind === 'lot' ? 'optional' : 'none',
  })
  if (defined.isLeft()) throw defined.value
}

const onHand = () => {
  const balance = unitOfWork.balances.find((candidate) => candidate.itemId() === itemId)
  return balance ? snapshotOf(balance).onHand : undefined
}

describe('goods a purchase delivers', () => {
  it('open a balance at the price the order agreed, and add to it on the next delivery', async () => {
    const first = await received([line()], warehouseId, randomUUID())
    expect(first.isRight() && first.value).toEqual({ movements: 1 })
    const second = await received([line({ quantity: '2' })])
    expect(second.isRight()).toBe(true)
    expect(unitOfWork.balances).toHaveLength(1)
    expect(onHand()).toBe('7')
  })

  it('name the receipt they came on, so a recall can be traced back to it', async () => {
    const receiptId = randomUUID()
    await received([line()], warehouseId, receiptId)
    const [moved] = unitOfWork.events.filter(
      (event): event is InventoryStockMovedEvent => event instanceof InventoryStockMovedEvent,
    )
    expect(moved?.movementOf().origin).toEqual({
      reason: 'purchase',
      document: { type: 'receipt', id: receiptId },
    })
  })

  it('are refused at a warehouse that does not exist or no longer receives', async () => {
    const missing = await received([line()], randomUUID())
    expect(missing.isLeft() && missing.value.constructor.name).toBe('ResourceNotFoundError')
    const closed = await received([line()], warehouse(false))
    expect(closed.isLeft() && closed.value.constructor.name).toBe('ConflictError')
    expect(unitOfWork.balances).toHaveLength(0)
  })

  it('are refused, with nothing stocked, for a bad quantity, currency or price', async () => {
    for (const bad of [
      line({ quantity: '-1' }),
      line({ unitPrice: { amount: '100', currency: 'XX' } }),
      line({ unitPrice: { amount: 'abc', currency: 'BRL' } }),
    ]) {
      const result = await received([bad])
      expect(result.isLeft()).toBe(true)
    }
    expect(unitOfWork.balances).toHaveLength(0)
  })

  it('arrive under lots or serial numbers when the delivery names them', async () => {
    await tracked('lot')
    const lots = await received([
      line({ quantity: '5', lots: [{ code: 'L-01', expiresOn: '2027-01-31', quantity: '5' }] }),
    ])
    expect(lots.isRight()).toBe(true)
    itemId = randomUUID()
    await tracked('serial')
    const serials = await received([line({ quantity: '2', serials: ['SN-1', 'SN-2'] })])
    expect(serials.isRight()).toBe(true)
  })

  it('refuse lots that do not add up, and a serial number already in stock', async () => {
    await tracked('lot')
    const short = await received([line({ quantity: '5', lots: [{ code: 'L-01', quantity: '2' }] })])
    expect(short.isLeft()).toBe(true)
    itemId = randomUUID()
    await tracked('serial')
    await received([line({ quantity: '1', serials: ['SN-9'] })])
    const again = await received([line({ quantity: '1', serials: ['SN-9'] })])
    expect(again.isLeft()).toBe(true)
  })
})

describe('goods going back to their supplier', () => {
  it('leave stock again', async () => {
    await received([line({ quantity: '5' })])
    const result = await returned([{ itemId, quantity: '2' }], randomUUID())
    expect(result.isRight() && result.value).toEqual({ movements: 1 })
    expect(onHand()).toBe('3')
  })

  it('are refused when they are not in stock, or more than is there', async () => {
    const none = await returned([{ itemId, quantity: '1' }])
    expect(none.isLeft() && none.value.constructor.name).toBe('ResourceNotFoundError')
    await received([line({ quantity: '1' })])
    const more = await returned([{ itemId, quantity: '3' }])
    expect(more.isLeft()).toBe(true)
    expect(onHand()).toBe('1')
  })

  it('are refused for a bad quantity or a malformed list of lots', async () => {
    expect((await returned([{ itemId, quantity: 'x' }])).isLeft()).toBe(true)
    const picked = await returned([{ itemId, quantity: '1', lots: [{ code: '', quantity: '1' }] }])
    expect(picked.isLeft()).toBe(true)
  })
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

const money = (amount: string) => ({ amount, currency: 'BRL' })
const receiptLine = (quantity: string) => ({
  lineId: randomUUID(),
  itemId,
  quantity,
  description: 'Café torrado',
  unitPrice: money('1200'),
  lineTotal: money('6000'),
})

function recorded(quantity: string, target = warehouseId) {
  return envelope('procurement.receipt.recorded', {
    orderId: randomUUID(),
    orderVersion: 2,
    receiptId: randomUUID(),
    receivedBy: 'user-keeper',
    receivedOn: '2026-09-30',
    supplierId: randomUUID(),
    supplierName: 'Torrefação Aurora',
    warehouseId: target,
    notes: null,
    overReceipt: false,
    complete: true,
    value: money('6000'),
    installments: [],
    remaining: money('0'),
    remainingInstallments: [],
    lines: [receiptLine(quantity)],
  })
}

describe('the procurement events Inventory follows', () => {
  it('stock a recorded receipt once, however often it is delivered', async () => {
    const handlers = new InventoryProcurementEventHandlers(unitOfWork, clock)
    const event = recorded('5')
    const handle = handlers.handlers[event.eventType]
    await handle?.(event)
    await handle?.(event)
    expect(onHand()).toBe('5')
  })

  it('take a returned receipt out of stock', async () => {
    const handlers = new InventoryProcurementEventHandlers(unitOfWork, clock)
    const arrived = recorded('5')
    await handlers.handlers[arrived.eventType]?.(arrived)
    const back = envelope('procurement.receipt.returned', {
      orderId: randomUUID(),
      orderVersion: 3,
      receiptId: randomUUID(),
      returnedBy: 'user-keeper',
      reason: 'Embalagem avariada',
      warehouseId,
      remaining: money('6000'),
      remainingInstallments: [],
      lines: [{ lineId: randomUUID(), itemId, quantity: '5' }],
    })
    await handlers.handlers[back.eventType]?.(back)
    expect(onHand()).toBe('0')
  })

  it('throw when the delivery cannot be stocked, so the event is retried and not lost', async () => {
    const handlers = new InventoryProcurementEventHandlers(unitOfWork, clock)
    const nowhere = recorded('5', randomUUID())
    await expect(handlers.handlers[nowhere.eventType]?.(nowhere)).rejects.toThrow()
    const back = envelope('procurement.receipt.returned', {
      orderId: randomUUID(),
      orderVersion: 3,
      receiptId: randomUUID(),
      returnedBy: 'user-keeper',
      reason: 'Nunca chegou',
      warehouseId,
      remaining: money('0'),
      remainingInstallments: [],
      lines: [{ lineId: randomUUID(), itemId, quantity: '5' }],
    })
    await expect(handlers.handlers[back.eventType]?.(back)).rejects.toThrow()
  })
})

describe('the catalogue compositions Inventory keeps', () => {
  it('records a version once, with its components per unit', async () => {
    const handlers = new InventoryCatalogEventHandlers(unitOfWork, clock)
    const event = envelope('catalog.composition.defined', {
      compositionId: randomUUID(),
      parentItemId: itemId,
      version: 1,
      realisation: 'assembled',
      effectiveFrom: '2026-10-01',
      lines: [{ componentItemId: randomUUID(), quantity: '2' }],
    })
    await handlers.handlers[event.eventType]?.(event)
    await handlers.handlers[event.eventType]?.(event)
    expect(unitOfWork.compositionsHeard).toHaveLength(1)
    expect(unitOfWork.compositionsHeard[0]?.composition).toMatchObject({
      parentItemId: itemId,
      version: 1,
    })
  })
})
