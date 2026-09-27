import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import { InMemorySalesUnitOfWork } from 'test/repositories/in-memory-sales-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { SalesModuleEventHandlers } from './consume-module-events'
import { PlaceOrderUseCase } from './use-cases/place-order'

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

async function projectItem(handlers: SalesModuleEventHandlers, tenantId: string, itemId: string) {
  const created = envelope('catalog.item.created', tenantId, {
    itemId,
    kind: 'product',
    sku: 'COFFEE-1',
    name: 'Coffee',
    unitId: randomUUID(),
    ncm: '09012100',
  })
  await required(handlers.handlers[created.eventType])(created)
  const priced = envelope('catalog.price.changed', tenantId, {
    priceListId: randomUUID(),
    itemId,
    amount: '1250',
    currency: 'BRL',
  })
  await required(handlers.handlers[priced.eventType])(priced)
}

async function placedOrder(unitOfWork: InMemorySalesUnitOfWork, tenantId: string, itemId: string) {
  const placed = await new PlaceOrderUseCase(unitOfWork, clock).execute({
    context: { tenantId, actor: 'ana', requestId: null, idempotencyKey: randomUUID() },
    customerId: randomUUID(),
    fulfillmentWarehouseId: randomUUID(),
    lines: [{ lineId: randomUUID(), itemId, quantity: '2' }],
  })
  if (placed.isLeft()) throw placed.value
  return placed.value.orderId
}

describe('party events in both versions', () => {
  const details = {
    legalName: 'Acme GmbH',
    tradeName: null,
    email: 'buyer@acme.example',
    phone: '+4930123456',
    address: 'Hauptstraße 1, Berlin',
    roles: ['customer'],
  }

  async function projectedFrom(event: EventEnvelope) {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const handlers = new SalesModuleEventHandlers(unitOfWork, clock)
    await required(handlers.handlers[event.eventType])(event)
    const { createdAt, updatedAt, ...projection } = snapshotOf(required(unitOfWork.customers[0]))
    return projection
  }

  it('projects the same customer from a v1 replay and a v2 event', async () => {
    const tenantId = randomUUID()
    const partyId = randomUUID()
    const v1 = envelope('parties.party.registered', tenantId, {
      partyId,
      kind: 'organization',
      ...details,
    })
    const v2 = {
      ...envelope('parties.party.registered', tenantId, {
        partyId,
        kind: 'organization',
        ...details,
        documentType: 'foreign',
        documentCountry: 'DE',
      }),
      eventVersion: 2,
    }
    expect(await projectedFrom(v2)).toEqual(await projectedFrom(v1))
  })

  it('reads a v2 update of a prospect with no contacts as none of its business', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const handlers = new SalesModuleEventHandlers(unitOfWork, clock)
    const updated = {
      ...envelope('parties.party.updated', randomUUID(), {
        partyId: randomUUID(),
        legalName: 'Maria',
        tradeName: null,
        email: null,
        phone: null,
        address: null,
        documentType: 'none',
        documentCountry: null,
        roles: ['prospect'],
        active: true,
      }),
      eventVersion: 2,
    }
    await required(handlers.handlers[updated.eventType])(updated)
    expect(unitOfWork.customers).toHaveLength(0)
  })
})

describe('sales module event handlers', () => {
  it('projects catalog facts and confirms an order once', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const handlers = new SalesModuleEventHandlers(unitOfWork, clock)
    const tenantId = randomUUID()
    const itemId = randomUUID()
    await projectItem(handlers, tenantId, itemId)
    const orderId = await placedOrder(unitOfWork, tenantId, itemId)
    const reserved = envelope('inventory.stock.reserved', tenantId, {
      orderId,
      orderVersion: 1,
      reservationId: randomUUID(),
      expiresAt: new Date(now.getTime() + 900_000).toISOString(),
      lines: [{ lineId: randomUUID(), itemId, warehouseId: randomUUID(), quantity: '2' }],
    })
    await required(handlers.handlers[reserved.eventType])(reserved)
    await required(handlers.handlers[reserved.eventType])(reserved)
    expect(snapshotOf(required(unitOfWork.orders[0]))).toMatchObject({
      status: 'confirmed',
      version: 2,
      total: { amount: '2500', currency: 'BRL' },
    })
    expect(unitOfWork.consumedEvents.size).toBe(3)
  })

  it('applies reservation rejection and catalog deactivation', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const handlers = new SalesModuleEventHandlers(unitOfWork, clock)
    const tenantId = randomUUID()
    const itemId = randomUUID()
    await projectItem(handlers, tenantId, itemId)
    const orderId = await placedOrder(unitOfWork, tenantId, itemId)
    const rejected = envelope('inventory.stock.reservation-rejected', tenantId, {
      orderId,
      orderVersion: 1,
      shortfalls: [
        {
          lineId: randomUUID(),
          itemId,
          warehouseId: randomUUID(),
          quantity: '2',
          availableQuantity: '0',
        },
      ],
    })
    await required(handlers.handlers[rejected.eventType])(rejected)
    expect(snapshotOf(required(unitOfWork.orders[0]))).toMatchObject({
      status: 'rejected',
      version: 2,
    })

    const deactivated = envelope('catalog.item.deactivated', tenantId, { itemId })
    await required(handlers.handlers[deactivated.eventType])(deactivated)
    await unitOfWork.inTenant(tenantId, async (scope) => {
      expect((await scope.catalogItems.findById(itemId))?.active).toBe(false)
    })
  })
})
