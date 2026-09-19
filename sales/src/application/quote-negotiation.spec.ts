import { randomUUID } from 'node:crypto'
import { InMemorySalesUnitOfWork } from 'test/repositories/in-memory-sales-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { Currency, LineDescription, Money } from '@/domain/value-objects/sales-values'
import { ApplyStockReservedUseCase } from './use-cases/apply-reservation-outcome'
import type { IdempotentContext } from './use-cases/commands'
import { ConvertQuoteUseCase } from './use-cases/convert-quote'
import {
  DecideQuoteUseCase,
  ReviseQuoteUseCase,
  WriteQuoteUseCase,
} from './use-cases/manage-quotes'
import { PlaceOrderUseCase } from './use-cases/place-order'
import { ProjectPartyUseCase } from './use-cases/project-parties'

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
const brl = unwrap(Currency.create('BRL'))

function commandOf(tenantId: string, actor = 'ana'): IdempotentContext {
  return { tenantId, actor, requestId: null, idempotencyKey: randomUUID() }
}

/** A customer, one catalogue item at 1000, and a line quoting two of them. */
async function fixture(unitOfWork: InMemorySalesUnitOfWork, unitPrice = '1000') {
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
  unitOfWork.catalogItems.push({
    tenantId,
    itemId,
    description: unwrap(LineDescription.create('Coffee')),
    unitPrice: unwrap(Money.create(unitPrice, brl)),
    active: true,
  })
  return { tenantId, customerId, itemId, lineId: randomUUID() }
}

async function acceptedQuote(unitOfWork: InMemorySalesUnitOfWork) {
  const seed = await fixture(unitOfWork)
  const written = unwrap(
    await new WriteQuoteUseCase(unitOfWork, clock, 15).execute({
      context: commandOf(seed.tenantId),
      customerId: seed.customerId,
      quote: {
        lines: [{ lineId: seed.lineId, itemId: seed.itemId, quantity: '2' }],
        terms: { freight: '500', discount: '200', paymentTermDays: [0, 30], carrier: 'Correios' },
      },
    }),
  )
  const decide = new DecideQuoteUseCase(unitOfWork, clock)
  unwrap(await decide.send(commandOf(seed.tenantId), written.quoteId))
  unwrap(await decide.accept(commandOf(seed.tenantId), written.quoteId))
  return { ...seed, quoteId: written.quoteId }
}

describe('negotiating an offer and turning it into an order', () => {
  it('changes a draft in place and answers a sent offer with a new version', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const seed = await fixture(unitOfWork)
    const revise = new ReviseQuoteUseCase(unitOfWork, clock, 15)
    const written = unwrap(
      await new WriteQuoteUseCase(unitOfWork, clock, 15).execute({
        context: commandOf(seed.tenantId),
        customerId: seed.customerId,
        quote: { lines: [{ lineId: seed.lineId, itemId: seed.itemId, quantity: '2' }] },
      }),
    )

    // Nobody has seen the draft, so it is simply corrected.
    const corrected = unwrap(
      await revise.execute({
        context: commandOf(seed.tenantId),
        quoteId: written.quoteId,
        quote: { lines: [{ lineId: seed.lineId, itemId: seed.itemId, quantity: '3' }] },
      }),
    )
    expect(corrected).toEqual({ quoteId: written.quoteId, version: 1 })
    expect(unitOfWork.quotes).toHaveLength(1)

    unwrap(
      await new DecideQuoteUseCase(unitOfWork, clock).send(
        commandOf(seed.tenantId),
        written.quoteId,
      ),
    )
    const next = unwrap(
      await revise.execute({
        context: commandOf(seed.tenantId),
        quoteId: written.quoteId,
        quote: {
          lines: [{ lineId: seed.lineId, itemId: seed.itemId, quantity: '3' }],
          terms: { discount: '500' },
        },
      }),
    )
    expect(next.version).toBe(2)
    expect(next.quoteId).not.toBe(written.quoteId)
    // What the customer was shown is kept; the new version stands beside it.
    expect(snapshotOf(required(unitOfWork.quotes[0]))).toMatchObject({
      status: 'superseded',
      version: 1,
      supersededBy: next.quoteId,
    })
    expect(snapshotOf(required(unitOfWork.quotes[1]))).toMatchObject({
      status: 'draft',
      version: 2,
      rootId: written.quoteId,
      supersedes: written.quoteId,
      discount: '500',
    })
  })

  it('makes the accepted offer binding as the order that delivers it', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const seed = await acceptedQuote(unitOfWork)
    const converted = unwrap(
      await new ConvertQuoteUseCase(unitOfWork, clock).execute({
        context: commandOf(seed.tenantId),
        quoteId: seed.quoteId,
        fulfillmentWarehouseId: randomUUID(),
      }),
    )
    expect(snapshotOf(required(unitOfWork.orders[0]))).toMatchObject({
      id: converted.orderId,
      status: 'placed',
      quoteId: seed.quoteId,
      customerId: seed.customerId,
      discount: '200',
      freight: '500',
      carrier: 'Correios',
      paymentTermDays: [0, 30],
      requestedLines: [{ itemId: seed.itemId, quantity: '2', unitPrice: { amount: '1000' } }],
    })
    // One acceptance can never become two commitments.
    expect(snapshotOf(required(unitOfWork.quotes[0]))).toMatchObject({ orderId: converted.orderId })
    const second = await new ConvertQuoteUseCase(unitOfWork, clock).execute({
      context: commandOf(seed.tenantId),
      quoteId: seed.quoteId,
      fulfillmentWarehouseId: randomUUID(),
    })
    expect(second.isLeft()).toBe(true)
    expect(unitOfWork.orders).toHaveLength(1)
  })

  it('confirms a converted order at the price the customer agreed to', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const seed = await acceptedQuote(unitOfWork)
    const converted = unwrap(
      await new ConvertQuoteUseCase(unitOfWork, clock).execute({
        context: commandOf(seed.tenantId),
        quoteId: seed.quoteId,
        fulfillmentWarehouseId: randomUUID(),
      }),
    )
    // The price list moves between the yes and the reservation. That is not a new agreement.
    const item = required(unitOfWork.catalogItems[0])
    unitOfWork.catalogItems[0] = { ...item, unitPrice: unwrap(Money.create('1800', brl)) }
    unwrap(
      await new ApplyStockReservedUseCase(unitOfWork, clock).execute({
        tenantId: seed.tenantId,
        orderId: converted.orderId,
        orderVersion: 1,
        reservationId: randomUUID(),
      }),
    )
    // Two at a thousand, plus five hundred of freight, less two hundred agreed off.
    expect(snapshotOf(required(unitOfWork.orders[0]))).toMatchObject({
      status: 'confirmed',
      total: { amount: '2300', currency: 'BRL' },
    })
    const confirmed = required(
      unitOfWork.events.find((event) => event.eventType === 'sales.order.confirmed'),
    )
    expect(confirmed.payloadOf()).toMatchObject({
      total: { amount: '2300', currency: 'BRL' },
      installments: [
        { number: 1, dueOn: '2026-09-14', amount: { amount: '1150', currency: 'BRL' } },
        { number: 2, dueOn: '2026-10-14', amount: { amount: '1150', currency: 'BRL' } },
      ],
    })
  })

  it('publishes one instalment for an order nobody agreed terms for', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const seed = await fixture(unitOfWork)
    const placed = unwrap(
      await new PlaceOrderUseCase(unitOfWork, clock).execute({
        context: commandOf(seed.tenantId),
        customerId: seed.customerId,
        fulfillmentWarehouseId: randomUUID(),
        lines: [{ lineId: seed.lineId, itemId: seed.itemId, quantity: '2' }],
      }),
    )
    unwrap(
      await new ApplyStockReservedUseCase(unitOfWork, clock).execute({
        tenantId: seed.tenantId,
        orderId: placed.orderId,
        orderVersion: 1,
        reservationId: randomUUID(),
      }),
    )
    const confirmed = required(
      unitOfWork.events.find((event) => event.eventType === 'sales.order.confirmed'),
    )
    expect(confirmed.payloadOf()).toMatchObject({
      installments: [{ number: 1, dueOn: '2026-09-14', amount: { amount: '2000' } }],
    })
  })

  it('answers a retried conversion with the order it already made', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const seed = await acceptedQuote(unitOfWork)
    const convert = new ConvertQuoteUseCase(unitOfWork, clock)
    const request = {
      context: commandOf(seed.tenantId),
      quoteId: seed.quoteId,
      fulfillmentWarehouseId: randomUUID(),
    }
    const first = unwrap(await convert.execute(request))
    const retried = unwrap(await convert.execute(request))
    expect(retried).toEqual(first)
    expect(unitOfWork.orders).toHaveLength(1)
    // The same key for a different request is a mistake worth refusing outright.
    const reused = await convert.execute({ ...request, fulfillmentWarehouseId: randomUUID() })
    expect(reused.isLeft()).toBe(true)
  })

  it('writes down who decided what, against the document they decided it on', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const seed = await acceptedQuote(unitOfWork)
    const converted = unwrap(
      await new ConvertQuoteUseCase(unitOfWork, clock).execute({
        context: commandOf(seed.tenantId, 'bruno'),
        quoteId: seed.quoteId,
        fulfillmentWarehouseId: randomUUID(),
      }),
    )
    expect(unitOfWork.auditRecords.map((record) => record.action)).toEqual([
      'quote.written',
      'quote.send',
      'quote.accept',
      'order.placed',
      'quote.converted',
    ])
    const conversion = required(unitOfWork.auditRecords.at(-1))
    expect(conversion).toMatchObject({
      actor: 'bruno',
      subjectType: 'quote',
      subjectId: seed.quoteId,
      details: { orderId: converted.orderId, version: 1 },
    })
  })

  it('will not make an order out of an offer nobody accepted', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const seed = await fixture(unitOfWork)
    const written = unwrap(
      await new WriteQuoteUseCase(unitOfWork, clock, 15).execute({
        context: commandOf(seed.tenantId),
        customerId: seed.customerId,
        quote: { lines: [{ lineId: seed.lineId, itemId: seed.itemId, quantity: '2' }] },
      }),
    )
    const convert = new ConvertQuoteUseCase(unitOfWork, clock)
    expect(
      (
        await convert.execute({
          context: commandOf(seed.tenantId),
          quoteId: written.quoteId,
          fulfillmentWarehouseId: randomUUID(),
        })
      ).isLeft(),
    ).toBe(true)
    expect(
      (
        await convert.execute({
          context: commandOf(seed.tenantId),
          quoteId: randomUUID(),
          fulfillmentWarehouseId: randomUUID(),
        })
      ).isLeft(),
    ).toBe(true)
    expect(unitOfWork.orders).toHaveLength(0)
  })
})
