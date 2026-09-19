import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FinancialModuleEventHandlers } from '@/application/consume-module-events'
import { FinancialDatabase } from '@/infrastructure/database/drizzle/financial-database'

const clock = { now: () => new Date() }
let database: FinancialDatabase
let handlers: FinancialModuleEventHandlers

beforeAll(() => {
  database = new FinancialDatabase({ url: process.env.DATABASE_URL ?? '' })
  handlers = new FinancialModuleEventHandlers(database, clock)
})

afterAll(async () => {
  await Promise.allSettled([database?.close()])
})

const brl = (amount: string) => ({ amount, currency: 'BRL' })
const TODAY = '2026-09-25'

function envelope(
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
): EventEnvelope {
  return {
    eventId: randomUUID(),
    tenantId,
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    traceId: randomBytes(16).toString('hex'),
    payload,
  }
}

async function deliver(event: EventEnvelope): Promise<void> {
  const handler = handlers.handlers[event.eventType]
  if (!handler) throw new Error(`no handler for ${event.eventType}`)
  await handler(event)
}

const ORDER_LINE = () => ({
  lineId: randomUUID(),
  itemId: randomUUID(),
  description: 'Papel A4 75g, resma',
  quantity: '10',
  unitPrice: brl('2500'),
  lineTotal: brl('25000'),
})

/**
 * One purchase, from the commitment to the goods.
 *
 * Every figure here is the one Procurement publishes: Financial works out nothing about
 * terms or apportionment, it only decides what is expected and what is owed.
 */
function purchase() {
  const tenantId = randomUUID()
  const orderId = randomUUID()
  const supplierId = randomUUID()
  const warehouseId = randomUUID()
  const line = ORDER_LINE()

  const commercial = {
    supplierId,
    supplierName: 'Papelaria Central Ltda',
    requisitionId: null,
    warehouseId,
    issuedOn: '2026-09-16',
    expectedOn: '2026-09-30',
    total: brl('35000'),
    lines: [line],
  }

  const approved = () =>
    envelope(tenantId, 'procurement.order.approved', {
      orderId,
      orderVersion: 2,
      approvedBy: 'user:manager',
      approvalRequired: true,
      installments: [{ number: 1, dueOn: '2026-10-16', amount: brl('35000') }],
      ...commercial,
    })

  const received = (options: {
    receiptId: string
    value: string
    remaining: string
    dueOn?: string
    complete?: boolean
  }) =>
    envelope(tenantId, 'procurement.receipt.recorded', {
      orderId,
      orderVersion: 3,
      receiptId: options.receiptId,
      receivedBy: 'user:warehouse',
      receivedOn: '2026-09-20',
      supplierId,
      supplierName: 'Papelaria Central Ltda',
      warehouseId,
      notes: null,
      overReceipt: false,
      complete: options.complete ?? false,
      value: brl(options.value),
      installments: [
        { number: 1, dueOn: options.dueOn ?? '2026-10-20', amount: brl(options.value) },
      ],
      remaining: brl(options.remaining),
      remainingInstallments:
        options.remaining === '0'
          ? []
          : [{ number: 1, dueOn: '2026-10-16', amount: brl(options.remaining) }],
      lines: [line],
    })

  const returned = (receiptId: string, remaining: string) =>
    envelope(tenantId, 'procurement.receipt.returned', {
      orderId,
      orderVersion: 4,
      receiptId,
      returnedBy: 'user:warehouse',
      reason: 'The paper arrived damaged',
      warehouseId,
      remaining: brl(remaining),
      remainingInstallments: [{ number: 1, dueOn: '2026-10-16', amount: brl(remaining) }],
      lines: [{ lineId: line.lineId, itemId: line.itemId, quantity: '10' }],
    })

  const closed = (complete: boolean) =>
    envelope(tenantId, 'procurement.order.closed', {
      orderId,
      orderVersion: 5,
      reason: 'The supplier cannot deliver the rest',
      complete,
      receipts: 1,
    })

  // A forecast appears in no view but its own — `all` included — because that list is
  // what everyone reads as "the payables" (phase 24).
  const listing = async (view: 'all' | 'forecast' | 'closed') =>
    (await database.listTitles(tenantId, 'payable', { view, today: TODAY, limit: 50, offset: 0 }))
      .data

  const titles = async () => [...(await listing('all')), ...(await listing('forecast'))]
  /** A title that went nowhere is history whichever stage it was in. */
  const withdrawn = () => listing('closed')

  return { tenantId, orderId, approved, received, returned, closed, titles, listing, withdrawn }
}

async function forecastOf(shop: ReturnType<typeof purchase>) {
  const all = await shop.titles()
  return all.find((title) => title.stage === 'forecast')
}

describe('a purchase becomes money', () => {
  it('commits as a forecast, and only what arrives becomes owed', async () => {
    const shop = purchase()
    await deliver(shop.approved())
    const forecast = await forecastOf(shop)
    expect(forecast?.total).toBe('35000')
    expect(forecast?.stage).toBe('forecast')

    await deliver(shop.received({ receiptId: randomUUID(), value: '14000', remaining: '21000' }))
    const afterFirst = await shop.titles()
    // The delivery is owed; the order still expects the rest, and never both at once.
    expect(afterFirst.find((title) => title.stage === 'effective')?.total).toBe('14000')
    expect(afterFirst.find((title) => title.stage === 'forecast')?.total).toBe('21000')

    await deliver(
      shop.received({
        receiptId: randomUUID(),
        value: '21000',
        remaining: '0',
        complete: true,
      }),
    )
    const afterSecond = await shop.titles()
    // Nothing is expected any more, and the two deliveries add up to the order.
    expect(
      afterSecond.filter((title) => title.stage === 'forecast' && title.status === 'draft'),
    ).toHaveLength(0)
    const owed = afterSecond
      .filter((title) => title.stage === 'effective' && title.status === 'draft')
      .reduce((total, title) => total + BigInt(title.total), 0n)
    expect(owed).toBe(35_000n)
  })

  it('raises one payable per delivery, however often the event is redelivered', async () => {
    const shop = purchase()
    const approval = shop.approved()
    await deliver(approval)
    await deliver({ ...approval, eventId: randomUUID() })
    const receipt = shop.received({ receiptId: randomUUID(), value: '14000', remaining: '21000' })
    await deliver(receipt)
    await deliver({ ...receipt, eventId: randomUUID() })
    const all = await shop.titles()
    expect(all.filter((title) => title.status === 'draft')).toHaveLength(2)
  })

  it('withdraws what a returned delivery made owed, and expects it again', async () => {
    const shop = purchase()
    await deliver(shop.approved())
    const receiptId = randomUUID()
    await deliver(shop.received({ receiptId, value: '35000', remaining: '0', complete: true }))
    expect(await forecastOf(shop)).toBeUndefined()

    await deliver(shop.returned(receiptId, '35000'))
    // What the delivery owed is withdrawn, and the whole order is committed again.
    const gone = await shop.withdrawn()
    expect(gone.filter((title) => title.stage === 'effective')).toHaveLength(1)
    const forecast = (await shop.listing('forecast'))[0]
    expect(forecast?.total).toBe('35000')
  })

  it('stops expecting anything from an order that will receive no more', async () => {
    const shop = purchase()
    await deliver(shop.approved())
    await deliver(shop.received({ receiptId: randomUUID(), value: '14000', remaining: '21000' }))
    await deliver(shop.closed(false))
    // Nothing is expected from the order any more...
    expect(await shop.listing('forecast')).toHaveLength(0)
    expect((await shop.withdrawn()).filter((title) => title.stage === 'forecast')).toHaveLength(1)
    // ...but what already arrived is still owed: closing an order does not unbuy it.
    const owed = await shop.listing('all')
    expect(owed).toHaveLength(1)
    expect(owed[0]?.total).toBe('14000')
  })

  it('keeps a forecast out of everything that reports what is owed', async () => {
    const shop = purchase()
    await deliver(shop.approved())
    const summary = await database.titlesSummary(shop.tenantId, 'payable', TODAY)
    expect(summary.forecasts).toBe(1)
    const open = await database.listTitles(shop.tenantId, 'payable', {
      view: 'open',
      today: TODAY,
      limit: 50,
      offset: 0,
    })
    expect(open.data).toHaveLength(0)
  })
})
