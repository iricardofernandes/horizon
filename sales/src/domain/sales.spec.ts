import { randomUUID } from 'node:crypto'
import { snapshotOf } from 'test/support/snapshot-of'
import { SalesOrder } from './entities/sales-order'
import {
  BusinessDate,
  Currency,
  LineDescription,
  Money,
  PaymentTerms,
  Quantity,
  Reason,
  TaxId,
} from './value-objects/sales-values'

function unwrap<T>(result: { isLeft(): boolean; value: T }): T {
  if (result.isLeft()) throw result.value
  return result.value
}

const quantity = (value: string) => unwrap(Quantity.create(value))
const currency = unwrap(Currency.create('BRL'))
const money = (value: string) => unwrap(Money.create(value, currency))
const description = (value: string) => unwrap(LineDescription.create(value))
const brl = unwrap(Currency.create('BRL'))
/** An order agreed on nothing in particular: no discount, no freight, paid on delivery. */
const plainTerms = {
  sellerId: null,
  discount: Money.fromAmount(0n, brl),
  freight: Money.fromAmount(0n, brl),
  carrier: null,
  paymentTerms: PaymentTerms.immediate(),
  notes: null,
}
const issuedOn = unwrap(BusinessDate.create('2026-09-14'))

it('preserves alphanumeric CNPJ in a legacy Sales customer', () => {
  expect(unwrap(TaxId.create('00.000.000/e08g-12')).value).toBe('00000000E08G12')
  expect(TaxId.create('00.000.000/E08G-AA').isLeft()).toBe(true)
})

function draft() {
  const line = { lineId: randomUUID(), itemId: randomUUID(), quantity: quantity('2.5') }
  const order = unwrap(
    SalesOrder.draft({
      terms: plainTerms,
      issuedOn,
      tenantId: randomUUID(),
      customerId: randomUUID(),
      fulfillmentWarehouseId: randomUUID(),
      lines: [line],
      now: new Date('2026-09-14T20:00:00.000Z'),
    }),
  )
  return { order, line }
}

describe('sales domain', () => {
  it('validates exact quantities, currencies, money and descriptions', () => {
    expect(quantity('2.500000').toString()).toBe('2.5')
    expect(quantity('0').isZero()).toBe(true)
    expect(Quantity.create('-1').isLeft()).toBe(true)
    expect(Currency.create('12').isLeft()).toBe(true)
    expect(Money.create('-1', currency).isLeft()).toBe(true)
    expect(description('  Ground   coffee ').value).toBe('Ground coffee')
    expect(LineDescription.create(' ').isLeft()).toBe(true)
    expect(Reason.create(' ').isLeft()).toBe(true)
    expect(money('125').multiply(quantity('2.5')).amount).toBe(313n)
    expect(money('100').plus(money('50')).amount).toBe(150n)
    const usd = unwrap(Currency.create('USD'))
    expect(() => money('100').plus(unwrap(Money.create('1', usd)))).toThrow(
      'money currencies differ',
    )
  })

  it('requires positive, uniquely identified order lines', () => {
    const common = {
      tenantId: randomUUID(),
      customerId: randomUUID(),
      fulfillmentWarehouseId: randomUUID(),
      now: new Date(),
    }
    expect(SalesOrder.draft({ ...common, terms: plainTerms, issuedOn, lines: [] }).isLeft()).toBe(
      true,
    )
    expect(
      SalesOrder.draft({
        ...common,
        lines: [{ lineId: randomUUID(), itemId: randomUUID(), quantity: quantity('0') }],
      }).isLeft(),
    ).toBe(true)
    const itemId = randomUUID()
    expect(
      SalesOrder.draft({
        ...common,
        lines: [
          { lineId: randomUUID(), itemId, quantity: quantity('1') },
          { lineId: randomUUID(), itemId, quantity: quantity('1') },
        ],
      }).isLeft(),
    ).toBe(true)
    const lineId = randomUUID()
    expect(
      SalesOrder.draft({
        ...common,
        lines: [
          { lineId, itemId: randomUUID(), quantity: quantity('1') },
          { lineId, itemId: randomUUID(), quantity: quantity('1') },
        ],
      }).isLeft(),
    ).toBe(true)
  })

  it('places an order once with a monotonic version', () => {
    const { order, line } = draft()
    expect(order.place(new Date('2026-09-14T20:01:00.000Z')).isRight()).toBe(true)
    expect(snapshotOf(order)).toMatchObject({ status: 'placed', version: 1 })
    expect(order.pullDomainEvents()[0]?.payloadOf()).toMatchObject({
      orderId: order.id.toString(),
      orderVersion: 1,
      lines: [{ lineId: line.lineId, quantity: '2.5' }],
    })
    expect(order.place(new Date()).isLeft()).toBe(true)
  })

  it('confirms only the matching reservation outcome and calculates immutable totals', () => {
    const { order, line } = draft()
    unwrap(order.place(new Date('2026-09-14T20:01:00.000Z')))
    order.pullDomainEvents()
    expect(
      order
        .confirm(
          0,
          randomUUID(),
          [
            {
              lineId: line.lineId,
              itemId: line.itemId,
              description: description('Coffee'),
              unitPrice: money('125'),
            },
          ],
          new Date(),
        )
        .isLeft(),
    ).toBe(true)
    const reservationId = randomUUID()
    expect(
      order
        .confirm(
          1,
          reservationId,
          [
            {
              lineId: line.lineId,
              itemId: line.itemId,
              description: description('Coffee'),
              unitPrice: money('125'),
            },
          ],
          new Date('2026-09-14T20:02:00.000Z'),
        )
        .isRight(),
    ).toBe(true)
    expect(snapshotOf(order)).toMatchObject({
      status: 'confirmed',
      version: 2,
      reservationId,
      total: { amount: '313', currency: 'BRL' },
    })
    const events = order.pullDomainEvents()
    expect(events.map((event) => event.eventType)).toEqual(['sales.order.confirmed'])
    expect(events[0]?.payloadOf()).toMatchObject({
      orderVersion: 2,
      confirmedAt: '2026-09-14T20:02:00.000Z',
      lines: [{ lineTotal: { amount: '313', currency: 'BRL' } }],
    })
  })

  it('rejects incomplete, mismatched or mixed-currency commercial snapshots', () => {
    const first = { lineId: randomUUID(), itemId: randomUUID(), quantity: quantity('1') }
    const second = { lineId: randomUUID(), itemId: randomUUID(), quantity: quantity('1') }
    const order = unwrap(
      SalesOrder.draft({
        terms: plainTerms,
        issuedOn,
        tenantId: randomUUID(),
        customerId: randomUUID(),
        fulfillmentWarehouseId: randomUUID(),
        lines: [first, second],
        now: new Date(),
      }),
    )
    unwrap(order.place(new Date()))
    expect(order.confirm(1, randomUUID(), [], new Date()).isLeft()).toBe(true)
    expect(
      order
        .confirm(
          1,
          randomUUID(),
          [
            {
              lineId: first.lineId,
              itemId: randomUUID(),
              description: description('Wrong'),
              unitPrice: money('1'),
            },
            {
              lineId: second.lineId,
              itemId: second.itemId,
              description: description('Second'),
              unitPrice: money('1'),
            },
          ],
          new Date(),
        )
        .isLeft(),
    ).toBe(true)
    const usd = unwrap(Currency.create('USD'))
    expect(
      order
        .confirm(
          1,
          randomUUID(),
          [
            {
              lineId: first.lineId,
              itemId: first.itemId,
              description: description('First'),
              unitPrice: money('1'),
            },
            {
              lineId: second.lineId,
              itemId: second.itemId,
              description: description('Second'),
              unitPrice: unwrap(Money.create('1', usd)),
            },
          ],
          new Date(),
        )
        .isLeft(),
    ).toBe(true)
  })

  it('rejects a current outcome, ignores stale ones and prevents later cancellation', () => {
    const stale = draft().order
    unwrap(stale.place(new Date()))
    expect(stale.rejectReservation(0, new Date()).isLeft()).toBe(true)
    expect(stale.rejectReservation(1, new Date()).isRight()).toBe(true)
    expect(snapshotOf(stale)).toMatchObject({ status: 'rejected', version: 2 })
    expect(stale.cancel(null, new Date()).isLeft()).toBe(true)
  })

  it('cancels a draft or placed order exactly once', () => {
    const { order } = draft()
    expect(
      order
        .cancel(
          unwrap(Reason.create('  customer   request ')),
          new Date('2026-09-14T20:01:00.000Z'),
        )
        .isRight(),
    ).toBe(true)
    expect(order.pullDomainEvents()[0]?.payloadOf()).toMatchObject({
      orderVersion: 1,
      reservationId: null,
      reason: 'customer request',
    })
    expect(order.cancel(null, new Date()).isLeft()).toBe(true)
  })
})
