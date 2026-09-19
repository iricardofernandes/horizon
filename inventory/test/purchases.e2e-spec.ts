import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InventoryProcurementEventHandlers } from '@/application/consume-procurement-events'
import { InventoryDatabase } from '@/infrastructure/database/drizzle/inventory-database'

let database: InventoryDatabase
let administrator: ReturnType<typeof postgres>
let handlers: InventoryProcurementEventHandlers

beforeAll(async () => {
  database = new InventoryDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  handlers = new InventoryProcurementEventHandlers(database, { now: () => new Date() })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end()])
})

async function warehouse() {
  const tenantId = randomUUID()
  const warehouseId = randomUUID()
  const itemId = randomUUID()
  await database.provisionTenant(tenantId)
  await administrator`insert into warehouses (id, tenant_id, name, created_at, updated_at)
    values (${warehouseId}, ${tenantId}, 'Main', now(), now())`
  return { tenantId, warehouseId, itemId }
}

type Fixture = Awaited<ReturnType<typeof warehouse>>

function receipt(fixture: Fixture, quantity: string, unitPrice = '2500') {
  return {
    eventId: randomUUID(),
    eventType: 'procurement.receipt.recorded',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId: fixture.tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload: {
      orderId: randomUUID(),
      orderVersion: 3,
      receiptId: randomUUID(),
      receivedBy: 'user:warehouse',
      receivedOn: '2026-09-20',
      supplierId: randomUUID(),
      supplierName: 'Papelaria Central Ltda',
      warehouseId: fixture.warehouseId,
      notes: null,
      overReceipt: false,
      complete: true,
      value: { amount: '25000', currency: 'BRL' },
      installments: [
        { number: 1, dueOn: '2026-10-20', amount: { amount: '25000', currency: 'BRL' } },
      ],
      remaining: { amount: '0', currency: 'BRL' },
      remainingInstallments: [],
      lines: [
        {
          lineId: randomUUID(),
          itemId: fixture.itemId,
          description: 'Papel A4 75g, resma',
          quantity,
          unitPrice: { amount: unitPrice, currency: 'BRL' },
          lineTotal: { amount: '25000', currency: 'BRL' },
        },
      ],
    },
  }
}

function giveBack(fixture: Fixture, lines: { itemId: string; quantity: string }[]) {
  return {
    eventId: randomUUID(),
    eventType: 'procurement.receipt.returned',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId: fixture.tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload: {
      orderId: randomUUID(),
      orderVersion: 4,
      receiptId: randomUUID(),
      returnedBy: 'user:warehouse',
      reason: 'The paper arrived damaged',
      warehouseId: fixture.warehouseId,
      remaining: { amount: '25000', currency: 'BRL' },
      remainingInstallments: [
        { number: 1, dueOn: '2026-10-16', amount: { amount: '25000', currency: 'BRL' } },
      ],
      lines: lines.map((line) => ({ lineId: randomUUID(), ...line })),
    },
  }
}

const deliver = (event: { eventType: string }) =>
  handlers.handlers[event.eventType]?.(
    event as Parameters<NonNullable<(typeof handlers.handlers)[string]>>[0],
  )

async function onHand(fixture: Fixture) {
  const [row] = await administrator`select on_hand, average_unit_cost from stock_balances
    where tenant_id = ${fixture.tenantId} and item_id = ${fixture.itemId}`
  return row
}

describe('what purchasing delivers', () => {
  it('brings the goods into stock at the price the order agreed', async () => {
    const fixture = await warehouse()
    await deliver(receipt(fixture, '10'))
    expect((await onHand(fixture))?.on_hand).toBe('10000000')
    expect((await onHand(fixture))?.average_unit_cost).toBe('2500')
  })

  it('moves stock once, however often the delivery is redelivered', async () => {
    const fixture = await warehouse()
    const event = receipt(fixture, '10')
    await deliver(event)
    await deliver(event)
    expect((await onHand(fixture))?.on_hand).toBe('10000000')
    expect(await administrator`select * from inbox where event_id = ${event.eventId}`).toHaveLength(
      1,
    )
  })

  it('takes the goods back out when the delivery is returned', async () => {
    const fixture = await warehouse()
    await deliver(receipt(fixture, '10'))
    await deliver(giveBack(fixture, [{ itemId: fixture.itemId, quantity: '10' }]))
    expect((await onHand(fixture))?.on_hand).toBe('0')
  })

  it('refuses to return goods somebody has already promised to a customer', async () => {
    const fixture = await warehouse()
    await deliver(receipt(fixture, '10'))
    await administrator`update stock_balances set reserved = 8000000
      where tenant_id = ${fixture.tenantId} and item_id = ${fixture.itemId}`
    await expect(
      deliver(giveBack(fixture, [{ itemId: fixture.itemId, quantity: '10' }])),
    ).rejects.toThrow(/no longer available/)
    // Nothing moved: a refused return leaves the shelf exactly as it was.
    expect((await onHand(fixture))?.on_hand).toBe('10000000')
  })
})
