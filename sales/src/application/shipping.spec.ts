import { randomUUID } from 'node:crypto'
import { InMemorySalesUnitOfWork } from 'test/repositories/in-memory-sales-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { Currency, LineDescription, Money } from '@/domain/value-objects/sales-values'
import { ApplyStockReservedUseCase } from './use-cases/apply-reservation-outcome'
import type { IdempotentContext } from './use-cases/commands'
import { PlaceOrderUseCase } from './use-cases/place-order'
import { ProjectPartyUseCase } from './use-cases/project-parties'
import {
  AbandonShipmentUseCase,
  DispatchShipmentUseCase,
  PackShipmentUseCase,
  PickShipmentUseCase,
  ReturnShipmentUseCase,
} from './use-cases/ship-orders'

function unwrap<T>(result: { isLeft(): boolean; value: T }): T {
  if (result.isLeft()) throw result.value
  return result.value
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing test fixture')
  return value
}

const now = new Date('2026-09-16T20:00:00.000Z')
const clock = { now: () => now }
const brl = unwrap(Currency.create('BRL'))

function commandOf(tenantId: string, actor = 'ana'): IdempotentContext {
  return { tenantId, actor, requestId: null, idempotencyKey: randomUUID() }
}

/** A confirmed order for ten units at 100, with 200 of freight: 1200 charged. */
async function confirmedOrder(unitOfWork: InMemorySalesUnitOfWork) {
  const tenantId = randomUUID()
  const customerId = randomUUID()
  unwrap(
    await unitOfWork.inTenant(tenantId, (scope) =>
      new ProjectPartyUseCase(clock).executeInScope(scope, {
        tenantId,
        partyId: customerId,
        legalName: 'Maria Silva',
        email: 'maria@example.com',
        phone: '+5511999999999',
        address: 'Rua Um, 42',
        roles: ['customer'],
        active: true,
      }),
    ),
  )
  const itemId = randomUUID()
  const lineId = randomUUID()
  unitOfWork.catalogItems.push({
    tenantId,
    itemId,
    description: unwrap(LineDescription.create('Coffee')),
    unitPrice: unwrap(Money.create('100', brl)),
    active: true,
  })
  const placed = unwrap(
    await new PlaceOrderUseCase(unitOfWork, clock).execute({
      context: commandOf(tenantId),
      customerId,
      fulfillmentWarehouseId: randomUUID(),
      terms: { freight: '200' },
      lines: [{ lineId, itemId, quantity: '10' }],
    }),
  )
  unwrap(
    await new ApplyStockReservedUseCase(unitOfWork, clock).execute({
      tenantId,
      orderId: placed.orderId,
      orderVersion: 1,
      reservationId: randomUUID(),
    }),
  )
  unitOfWork.events.length = 0
  return { tenantId, customerId, itemId, lineId, orderId: placed.orderId }
}

async function pickAndPack(
  unitOfWork: InMemorySalesUnitOfWork,
  fixture: { tenantId: string; orderId: string; lineId: string },
  quantity: string,
) {
  const picked = unwrap(
    await new PickShipmentUseCase(unitOfWork, clock).execute({
      context: commandOf(fixture.tenantId),
      orderId: fixture.orderId,
      lines: [{ lineId: fixture.lineId, quantity }],
    }),
  )
  unwrap(
    await new PackShipmentUseCase(unitOfWork, clock).execute({
      context: commandOf(fixture.tenantId),
      shipmentId: picked.shipmentId,
      consignment: { carrier: 'Correios', trackingCode: 'BR123' },
    }),
  )
  return picked.shipmentId
}

describe('getting the goods to the customer', () => {
  it('picks, packs and dispatches part of an order', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await confirmedOrder(unitOfWork)
    const shipmentId = await pickAndPack(unitOfWork, fixture, '4')
    expect(snapshotOf(required(unitOfWork.shipments[0]))).toMatchObject({
      status: 'packed',
      carrier: 'Correios',
      trackingCode: 'BR123',
      lines: [{ quantity: '4', unitPrice: { amount: '100' } }],
    })

    const dispatched = unwrap(
      await new DispatchShipmentUseCase(unitOfWork, clock).execute({
        context: commandOf(fixture.tenantId),
        shipmentId,
      }),
    )
    // Four of ten units of an order charged 1200: 480 goes, 720 is still expected.
    expect(dispatched).toMatchObject({ value: '480', remaining: '720', complete: false })
    expect(snapshotOf(required(unitOfWork.shipments[0]))).toMatchObject({
      status: 'dispatched',
      dispatchedOn: '2026-09-16',
      value: { amount: '480', currency: 'BRL' },
    })
    expect(snapshotOf(required(unitOfWork.orders[0]))).toMatchObject({
      fulfillment: 'partial',
      shipments: 1,
      requestedLines: [{ shipped: '4', allocated: '0' }],
    })
    expect(unitOfWork.events.map((event) => event.eventType)).toEqual([
      'sales.shipment.dispatched',
      'sales.invoicing.requested',
    ])
  })

  it('will not promise the same unit to two deliveries', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await confirmedOrder(unitOfWork)
    await pickAndPack(unitOfWork, fixture, '7')
    const tooMuch = await new PickShipmentUseCase(unitOfWork, clock).execute({
      context: commandOf(fixture.tenantId),
      orderId: fixture.orderId,
      lines: [{ lineId: fixture.lineId, quantity: '4' }],
    })
    expect(tooMuch.isLeft()).toBe(true)
    expect(unitOfWork.shipments).toHaveLength(1)
  })

  it('returns abandoned goods to the order, to be promised again', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await confirmedOrder(unitOfWork)
    const shipmentId = await pickAndPack(unitOfWork, fixture, '10')
    unwrap(
      await new AbandonShipmentUseCase(unitOfWork, clock).execute({
        context: commandOf(fixture.tenantId),
        shipmentId,
        reason: 'The pallet was damaged before it left',
      }),
    )
    expect(snapshotOf(required(unitOfWork.shipments[0])).status).toBe('abandoned')
    expect(snapshotOf(required(unitOfWork.orders[0]))).toMatchObject({
      fulfillment: 'unfulfilled',
      requestedLines: [{ shipped: '0', allocated: '0' }],
    })
    const again = await new PickShipmentUseCase(unitOfWork, clock).execute({
      context: commandOf(fixture.tenantId),
      orderId: fixture.orderId,
      lines: [{ lineId: fixture.lineId, quantity: '10' }],
    })
    expect(again.isRight()).toBe(true)
  })

  it('takes a delivery back, and owes those goods again', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await confirmedOrder(unitOfWork)
    const shipmentId = await pickAndPack(unitOfWork, fixture, '10')
    unwrap(
      await new DispatchShipmentUseCase(unitOfWork, clock).execute({
        context: commandOf(fixture.tenantId),
        shipmentId,
      }),
    )
    unitOfWork.events.length = 0
    const returned = unwrap(
      await new ReturnShipmentUseCase(unitOfWork, clock).execute({
        context: commandOf(fixture.tenantId),
        shipmentId,
        reason: 'Damaged in transit',
      }),
    )
    expect(returned).toMatchObject({ value: '1200', remaining: '1200' })
    expect(snapshotOf(required(unitOfWork.shipments[0]))).toMatchObject({
      status: 'returned',
      closureReason: 'Damaged in transit',
    })
    expect(snapshotOf(required(unitOfWork.orders[0]))).toMatchObject({
      fulfillment: 'unfulfilled',
      requestedLines: [{ shipped: '0' }],
    })
    const [event] = unitOfWork.events
    expect(event?.eventType).toBe('sales.shipment.returned')
    expect(event?.payloadOf()).toMatchObject({
      shipmentId,
      reason: 'Damaged in transit',
      value: { amount: '1200', currency: 'BRL' },
    })
  })

  it('answers a retried dispatch with what it already sent', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await confirmedOrder(unitOfWork)
    const shipmentId = await pickAndPack(unitOfWork, fixture, '10')
    const dispatch = new DispatchShipmentUseCase(unitOfWork, clock)
    const request = { context: commandOf(fixture.tenantId), shipmentId }
    const first = unwrap(await dispatch.execute(request))
    const retried = unwrap(await dispatch.execute(request))
    expect(retried).toEqual(first)
    expect(
      unitOfWork.events.filter((event) => event.eventType === 'sales.shipment.dispatched'),
    ).toHaveLength(1)
  })

  it('writes down every step of the delivery, and who took it', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await confirmedOrder(unitOfWork)
    const shipmentId = await pickAndPack(unitOfWork, fixture, '10')
    unwrap(
      await new DispatchShipmentUseCase(unitOfWork, clock).execute({
        context: commandOf(fixture.tenantId, 'bruno'),
        shipmentId,
      }),
    )
    expect(unitOfWork.auditRecords.map((record) => record.action)).toEqual([
      'order.placed',
      'shipment.picked',
      'shipment.packed',
      'shipment.dispatched',
    ])
    const dispatch = required(unitOfWork.auditRecords.at(-1))
    expect(dispatch).toMatchObject({
      actor: 'bruno',
      subjectType: 'shipment',
      subjectId: shipmentId,
      details: { value: 1200n, remaining: 0n, complete: true },
    })
  })

  it('refuses to dispatch a box nobody closed', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await confirmedOrder(unitOfWork)
    const picked = unwrap(
      await new PickShipmentUseCase(unitOfWork, clock).execute({
        context: commandOf(fixture.tenantId),
        orderId: fixture.orderId,
        lines: [{ lineId: fixture.lineId, quantity: '2' }],
      }),
    )
    const dispatched = await new DispatchShipmentUseCase(unitOfWork, clock).execute({
      context: commandOf(fixture.tenantId),
      shipmentId: picked.shipmentId,
    })
    expect(dispatched.isLeft()).toBe(true)
  })
})
