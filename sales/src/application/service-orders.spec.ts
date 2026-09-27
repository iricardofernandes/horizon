import { randomUUID } from 'node:crypto'
import { InMemorySalesUnitOfWork } from 'test/repositories/in-memory-sales-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import type { ItemKind } from '@/domain/repositories/sales-repositories'
import { Currency, LineDescription, Money } from '@/domain/value-objects/sales-values'
import type { IdempotentContext } from './use-cases/commands'
import { ConvertQuoteUseCase } from './use-cases/convert-quote'
import { DecideQuoteUseCase, WriteQuoteUseCase } from './use-cases/manage-quotes'
import { ProjectPartyUseCase } from './use-cases/project-parties'
import {
  DecideServiceOrderUseCase,
  DeliverServiceUseCase,
  OpenServiceOrderUseCase,
} from './use-cases/service-orders'

function unwrap<T>(result: { isLeft(): boolean; value: T }): T {
  if (result.isLeft()) throw result.value
  return result.value
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('missing test fixture')
  return value
}

const now = new Date('2026-09-20T15:00:00.000Z')
const clock = { now: () => now }
const brl = unwrap(Currency.create('BRL'))

function commandOf(tenantId: string, actor = 'ana'): IdempotentContext {
  return { tenantId, actor, requestId: null, idempotencyKey: randomUUID() }
}

async function tenantWithCustomer(unitOfWork: InMemorySalesUnitOfWork) {
  const tenantId = randomUUID()
  const customerId = randomUUID()
  unwrap(
    await unitOfWork.inTenant(tenantId, (scope) =>
      new ProjectPartyUseCase(clock).executeInScope(scope, {
        tenantId,
        partyId: customerId,
        legalName: 'Empresa Cliente',
        email: 'cliente@example.com',
        phone: '+5511999999999',
        address: 'Rua Um, 42',
        roles: ['customer'],
        active: true,
      }),
    ),
  )
  return { tenantId, customerId }
}

function item(
  unitOfWork: InMemorySalesUnitOfWork,
  tenantId: string,
  kind: ItemKind | null,
  price: string,
) {
  const itemId = randomUUID()
  unitOfWork.catalogItems.push({
    tenantId,
    itemId,
    description: unwrap(LineDescription.create(kind === 'service' ? 'Implantação' : 'Café')),
    unitPrice: unwrap(Money.create(price, brl)),
    active: true,
    kind,
  })
  return itemId
}

async function acceptedProposal(
  unitOfWork: InMemorySalesUnitOfWork,
  lines: readonly { itemId: string; quantity: string }[],
  terms: { discount?: string; freight?: string },
  seed: { tenantId: string; customerId: string },
) {
  const written = unwrap(
    await new WriteQuoteUseCase(unitOfWork, clock, 15).execute({
      context: commandOf(seed.tenantId),
      customerId: seed.customerId,
      quote: {
        lines: lines.map((line) => ({ lineId: randomUUID(), ...line })),
        terms: { ...terms, paymentTermDays: [0, 30] },
      },
    }),
  )
  const decide = new DecideQuoteUseCase(unitOfWork, clock)
  unwrap(await decide.send(commandOf(seed.tenantId), written.quoteId))
  unwrap(await decide.accept(commandOf(seed.tenantId), written.quoteId))
  return written.quoteId
}

describe('converting a proposal with services', () => {
  it('makes a sales order of the goods and a service order of the services, once', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const seed = await tenantWithCustomer(unitOfWork)
    const good = item(unitOfWork, seed.tenantId, 'product', '1000')
    const service = item(unitOfWork, seed.tenantId, 'service', '2000')
    const quoteId = await acceptedProposal(
      unitOfWork,
      [
        { itemId: good, quantity: '1' },
        { itemId: service, quantity: '1' },
      ],
      { discount: '300', freight: '500' },
      seed,
    )
    const convert = new ConvertQuoteUseCase(unitOfWork, clock)
    const request = {
      context: commandOf(seed.tenantId),
      quoteId,
      fulfillmentWarehouseId: randomUUID(),
    }
    const converted = unwrap(await convert.execute(request))
    expect(converted.orderId).not.toBeNull()
    expect(converted.serviceOrderId).not.toBeNull()
    expect(unwrap(await convert.execute(request))).toEqual(converted)

    const serviceOrder = snapshotOf(required(unitOfWork.serviceOrders[0]))
    // The services are two thirds of the net, so they take 200 of the 300 off; the goods
    // take 100 and carry the freight.
    expect(serviceOrder).toMatchObject({
      quoteId,
      status: 'scheduled',
      net: '2000',
      discount: '200',
      total: '1800',
      paymentTermDays: [0, 30],
    })
    const order = snapshotOf(required(unitOfWork.orders[0]))
    expect(order).toMatchObject({ discount: '100', freight: '500' })
    expect(order.requestedLines).toHaveLength(1)
    expect(snapshotOf(required(unitOfWork.quotes[0]))).toMatchObject({
      orderId: converted.orderId,
      serviceOrderId: converted.serviceOrderId,
    })
    const again = await convert.execute({ ...request, context: commandOf(seed.tenantId) })
    expect(again.isLeft()).toBe(true)
    expect(unitOfWork.serviceOrders).toHaveLength(1)
  })

  it('converts services alone without a warehouse, and refuses freight with no goods', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const seed = await tenantWithCustomer(unitOfWork)
    const service = item(unitOfWork, seed.tenantId, 'service', '2000')
    const convert = new ConvertQuoteUseCase(unitOfWork, clock)

    const alone = await acceptedProposal(unitOfWork, [{ itemId: service, quantity: '2' }], {}, seed)
    const converted = unwrap(
      await convert.execute({ context: commandOf(seed.tenantId), quoteId: alone }),
    )
    expect(converted).toMatchObject({ orderId: null, quoteId: alone })
    expect(unitOfWork.orders).toHaveLength(0)
    expect(unitOfWork.events.some((event) => event.eventType === 'sales.order.placed')).toBe(false)

    const freighted = await acceptedProposal(
      unitOfWork,
      [{ itemId: service, quantity: '1' }],
      { freight: '100' },
      seed,
    )
    const refused = await convert.execute({ context: commandOf(seed.tenantId), quoteId: freighted })
    expect(refused.isLeft()).toBe(true)
    expect((refused.value as Error).message).toMatch(/freight belongs to goods/)
  })

  it('still needs a warehouse for the goods of a proposal', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const seed = await tenantWithCustomer(unitOfWork)
    const good = item(unitOfWork, seed.tenantId, null, '1000')
    const quoteId = await acceptedProposal(unitOfWork, [{ itemId: good, quantity: '1' }], {}, seed)
    const refused = await new ConvertQuoteUseCase(unitOfWork, clock).execute({
      context: commandOf(seed.tenantId),
      quoteId,
    })
    expect(refused.isLeft()).toBe(true)
    expect(unitOfWork.serviceOrders).toHaveLength(0)
  })
})

describe('service orders opened directly', () => {
  it('opens services only, then starts, delivers, accepts and cancels a delivery', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const seed = await tenantWithCustomer(unitOfWork)
    const service = item(unitOfWork, seed.tenantId, 'service', '5000')
    const good = item(unitOfWork, seed.tenantId, 'product', '1000')
    const open = new OpenServiceOrderUseCase(unitOfWork, clock)

    const withGoods = await open.execute({
      context: commandOf(seed.tenantId),
      customerId: seed.customerId,
      lines: [{ lineId: randomUUID(), itemId: good, quantity: '1' }],
    })
    expect(withGoods.isLeft()).toBe(true)
    expect((withGoods.value as Error).message).toMatch(/service items only/)

    const lineId = randomUUID()
    const opened = unwrap(
      await open.execute({
        context: commandOf(seed.tenantId),
        customerId: seed.customerId,
        lines: [{ lineId, itemId: service, quantity: '2' }],
        terms: { paymentTermDays: [15] },
        scheduledFor: '2026-09-25',
      }),
    )
    expect(opened.total).toBe('10000')
    const decide = new DecideServiceOrderUseCase(unitOfWork, clock)
    unwrap(await decide.start(commandOf(seed.tenantId), opened.serviceOrderId))

    const deliver = new DeliverServiceUseCase(unitOfWork, clock)
    const first = unwrap(
      await deliver.execute({
        context: commandOf(seed.tenantId),
        serviceOrderId: opened.serviceOrderId,
        lines: [{ lineId, quantity: '1' }],
        performedOn: '2026-09-20',
      }),
    )
    expect(first).toMatchObject({ value: '5000', status: 'in_progress' })
    const rest = unwrap(
      await deliver.execute({
        context: commandOf(seed.tenantId),
        serviceOrderId: opened.serviceOrderId,
      }),
    )
    expect(rest).toMatchObject({ value: '5000', status: 'completed' })
    unwrap(await decide.accept(commandOf(seed.tenantId), opened.serviceOrderId))

    unwrap(
      await decide.cancelDelivery(
        commandOf(seed.tenantId),
        opened.serviceOrderId,
        first.deliveryId,
        'A primeira visita não aconteceu',
      ),
    )
    const published = unitOfWork.events.map((event) => event.eventType)
    expect(published.filter((type) => type === 'sales.service.delivered')).toHaveLength(2)
    expect(published).toContain('sales.service.delivery-cancelled')
    expect(unitOfWork.auditRecords.map((record) => record.action)).toEqual(
      expect.arrayContaining([
        'service-order.opened',
        'service-order.start',
        'service-order.delivered',
        'service-order.accept',
        'service-order.delivery-cancelled',
      ]),
    )
    const snapshot = snapshotOf(required(unitOfWork.serviceOrders[0]))
    expect(snapshot).toMatchObject({ status: 'in_progress', billed: '5000' })
    expect(snapshot.lines[0]).toMatchObject({ quantity: '2', delivered: '1' })
  })
})

describe('retrying a command', () => {
  it('answers a retry under the same key even when it is traced as a new request', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const seed = await tenantWithCustomer(unitOfWork)
    const service = item(unitOfWork, seed.tenantId, 'service', '5000')
    const open = new OpenServiceOrderUseCase(unitOfWork, clock)
    const request = {
      customerId: seed.customerId,
      lines: [{ lineId: randomUUID(), itemId: service, quantity: '1' }],
    }
    const context = commandOf(seed.tenantId)
    const first = unwrap(
      await open.execute({ ...request, context: { ...context, requestId: 'a' } }),
    )
    const retried = unwrap(
      await open.execute({ ...request, context: { ...context, requestId: 'b' } }),
    )
    expect(retried).toEqual(first)
    expect(unitOfWork.serviceOrders).toHaveLength(1)
    const changed = await open.execute({
      ...request,
      lines: [{ ...request.lines[0], quantity: '2' }],
      context,
    } as never)
    expect(changed.isLeft()).toBe(true)
  })
})
