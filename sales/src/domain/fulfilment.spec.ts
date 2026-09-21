import { randomUUID } from 'node:crypto'
import { snapshotOf } from 'test/support/snapshot-of'
import { SalesOrder } from './entities/sales-order'
import type { ConfirmedOrderLine } from './events/sales-events'
import type { ShippedLine } from './services/fulfilment'
import {
  BusinessDate,
  Currency,
  LineDescription,
  Money,
  PaymentTerms,
  Quantity,
  Reason,
} from './value-objects/sales-values'

function unwrap<T>(result: { isLeft(): boolean; value: T }): T {
  if (result.isLeft()) throw result.value
  return result.value
}

const brl = unwrap(Currency.create('BRL'))
const money = (value: string) => unwrap(Money.create(value, brl))
const quantity = (value: string) => unwrap(Quantity.create(value))
const issuedOn = unwrap(BusinessDate.create('2026-09-14'))
const dispatchedOn = unwrap(BusinessDate.create('2026-09-16'))
const written = new Date('2026-09-14T20:00:00.000Z')
const later = (minutes: number) => new Date(written.getTime() + minutes * 60_000)

/**
 * An order for ten units at 100, with 200 of freight and 100 off: 1000 of goods and 1100
 * charged. Every delivery carries its share of the 100 net difference.
 */
function confirmedOrder(options: { freight?: string; discount?: string; terms?: number[] } = {}) {
  const lineId = randomUUID()
  const itemId = randomUUID()
  const order = unwrap(
    SalesOrder.draft({
      tenantId: randomUUID(),
      customerId: randomUUID(),
      fulfillmentWarehouseId: randomUUID(),
      terms: {
        sellerId: null,
        discount: money(options.discount ?? '100'),
        freight: money(options.freight ?? '200'),
        carrier: null,
        paymentTerms: unwrap(PaymentTerms.create(options.terms ?? [30])),
        notes: null,
      },
      issuedOn,
      lines: [{ lineId, itemId, quantity: quantity('10') }],
      now: written,
    }),
  )
  unwrap(order.place(later(1)))
  unwrap(
    order.confirm(
      1,
      randomUUID(),
      [
        {
          lineId,
          itemId,
          description: unwrap(LineDescription.create('Coffee')),
          unitPrice: money('100'),
        },
      ],
      later(2),
    ),
  )
  order.pullDomainEvents()
  return { order, lineId, itemId }
}

function shipping(lineId: string, amount: string): ShippedLine[] {
  return [{ lineId, quantity: quantity(amount) }]
}

function shipmentOf(lines: readonly ConfirmedOrderLine[]) {
  return {
    shipmentId: randomUUID(),
    warehouseId: randomUUID(),
    carrier: null,
    trackingCode: null,
    dispatchedBy: 'user:warehouse',
    dispatchedOn,
    lines,
  }
}

describe('delivering what was sold', () => {
  it('holds what is being picked, so the same unit is never promised twice', () => {
    const { order, lineId } = confirmedOrder()
    expect(order.outstandingOf(lineId)?.toString()).toBe('10')
    const picked = unwrap(order.allocate(shipping(lineId, '4'), later(3)))
    expect(picked).toMatchObject([{ quantity: quantity('4'), unitPrice: money('100') }])
    expect(order.outstandingOf(lineId)?.toString()).toBe('6')
    // Six are left, so seven cannot be picked.
    expect(order.allocate(shipping(lineId, '7'), later(4)).isLeft()).toBe(true)
    expect(order.allocate(shipping(lineId, '6'), later(4)).isRight()).toBe(true)
    expect(order.outstandingOf(lineId)?.toString()).toBe('0')
  })

  it('gives the goods back to the order when a delivery is abandoned', () => {
    const { order, lineId } = confirmedOrder()
    unwrap(order.allocate(shipping(lineId, '4'), later(3)))
    expect(order.releaseAllocation(shipping(lineId, '4'), later(4)).isRight()).toBe(true)
    expect(order.outstandingOf(lineId)?.toString()).toBe('10')
    // Nothing is held any more, so nothing can be released.
    expect(order.releaseAllocation(shipping(lineId, '1'), later(5)).isLeft()).toBe(true)
  })

  it('carries a share of the order into each delivery, and the parts add back up', () => {
    const { order, lineId } = confirmedOrder()
    unwrap(order.allocate(shipping(lineId, '3'), later(3)))
    const first = unwrap(order.dispatch({ lines: shipping(lineId, '3'), dispatchedOn }, later(4)))
    // Three of ten units of an order charged 1100: 330 goes, 770 is still expected.
    expect(first.value.amount).toBe(330n)
    expect(first.remaining.amount).toBe(770n)
    expect(first.complete).toBe(false)
    expect(order.fulfillment()).toBe('partial')

    unwrap(order.allocate(shipping(lineId, '7'), later(5)))
    const second = unwrap(order.dispatch({ lines: shipping(lineId, '7'), dispatchedOn }, later(6)))
    expect(second.value.amount).toBe(770n)
    expect(second.remaining.amount).toBe(0n)
    expect(second.complete).toBe(true)
    expect(first.value.plus(second.value).amount).toBe(1100n)
    expect(order.fulfillment()).toBe('fulfilled')
    expect(snapshotOf(order)).toMatchObject({ fulfillment: 'fulfilled', shipments: 2 })
  })

  it('dates each delivery against the terms that were agreed', () => {
    const { order, lineId } = confirmedOrder({ terms: [0, 30] })
    unwrap(order.allocate(shipping(lineId, '10'), later(3)))
    const plan = unwrap(order.dispatch({ lines: shipping(lineId, '10'), dispatchedOn }, later(4)))
    // Half on dispatch, half thirty days after it; the order's own schedule is not reused.
    expect(plan.installments.map((part) => [part.dueOn.value, part.amount.amount])).toEqual([
      ['2026-09-16', 550n],
      ['2026-10-16', 550n],
    ])
    expect(plan.remainingInstallments).toHaveLength(0)
  })

  it('publishes the delivery and the invoice it should produce', () => {
    const { order, lineId } = confirmedOrder()
    const picked = unwrap(order.allocate(shipping(lineId, '4'), later(3)))
    const plan = unwrap(order.dispatch({ lines: shipping(lineId, '4'), dispatchedOn }, later(4)))
    order.dispatchEvent(shipmentOf(picked), plan, later(4))
    const events = order.pullDomainEvents()
    expect(events.map((event) => event.eventType)).toEqual([
      'sales.shipment.dispatched',
      'sales.invoicing.requested',
      'sales.fiscal-origin.recorded',
    ])
    expect(events[0]?.payloadOf()).toMatchObject({
      dispatchedOn: '2026-09-16',
      dispatchedBy: 'user:warehouse',
      value: { amount: '440', currency: 'BRL' },
      remaining: { amount: '660', currency: 'BRL' },
      complete: false,
      lines: [{ quantity: '4', lineTotal: { amount: '400', currency: 'BRL' } }],
    })
    // An invoice is written for what was shipped, not for the whole order.
    expect(events[1]?.payloadOf()).toMatchObject({ total: { amount: '440', currency: 'BRL' } })
  })

  it('refuses a delivery nobody picked, and one dated before the order existed', () => {
    const { order, lineId } = confirmedOrder()
    expect(order.dispatch({ lines: shipping(lineId, '1'), dispatchedOn }, later(3)).isLeft()).toBe(
      true,
    )
    unwrap(order.allocate(shipping(lineId, '1'), later(3)))
    const early = unwrap(BusinessDate.create('2026-09-13'))
    expect(
      order.dispatch({ lines: shipping(lineId, '1'), dispatchedOn: early }, later(4)).isLeft(),
    ).toBe(true)
  })

  it('puts a returned delivery back among what the order still owes', () => {
    const { order, lineId } = confirmedOrder()
    const picked = unwrap(order.allocate(shipping(lineId, '10'), later(3)))
    const plan = unwrap(order.dispatch({ lines: shipping(lineId, '10'), dispatchedOn }, later(4)))
    order.dispatchEvent(shipmentOf(picked), plan, later(4))
    order.pullDomainEvents()
    expect(order.fulfillment()).toBe('fulfilled')

    const undone = unwrap(order.unship(shipping(lineId, '10'), later(5)))
    expect(undone.value.amount).toBe(1100n)
    expect(undone.remaining.amount).toBe(1100n)
    expect(order.fulfillment()).toBe('unfulfilled')
    // The customer is owed those goods again, so they are outstanding again.
    expect(order.outstandingOf(lineId)?.toString()).toBe('10')
    order.returnEvent(
      {
        ...shipmentOf(picked),
        returnedBy: 'ana',
        returnedOn: dispatchedOn,
        reason: unwrap(Reason.create('Damaged')),
      },
      undone,
      later(5),
    )
    const [returned] = order.pullDomainEvents()
    expect(returned?.eventType).toBe('sales.shipment.returned')
    expect(returned?.payloadOf()).toMatchObject({
      reason: 'Damaged',
      value: { amount: '1100', currency: 'BRL' },
      remaining: { amount: '1100', currency: 'BRL' },
    })
  })

  it('refuses to return more than ever left', () => {
    const { order, lineId } = confirmedOrder()
    expect(order.unship(shipping(lineId, '1'), later(3)).isLeft()).toBe(true)
    unwrap(order.allocate(shipping(lineId, '2'), later(3)))
    unwrap(order.dispatch({ lines: shipping(lineId, '2'), dispatchedOn }, later(4)))
    expect(order.unship(shipping(lineId, '3'), later(5)).isLeft()).toBe(true)
    expect(order.unship(shipping(lineId, '2'), later(5)).isRight()).toBe(true)
  })

  it('will not ship an order nobody confirmed', () => {
    const lineId = randomUUID()
    const order = unwrap(
      SalesOrder.draft({
        tenantId: randomUUID(),
        customerId: randomUUID(),
        fulfillmentWarehouseId: randomUUID(),
        terms: {
          sellerId: null,
          discount: Money.fromAmount(0n, brl),
          freight: Money.fromAmount(0n, brl),
          carrier: null,
          paymentTerms: PaymentTerms.immediate(),
          notes: null,
        },
        issuedOn,
        lines: [{ lineId, itemId: randomUUID(), quantity: quantity('1') }],
        now: written,
      }),
    )
    expect(order.allocate(shipping(lineId, '1'), later(1)).isLeft()).toBe(true)
    unwrap(order.place(later(1)))
    expect(order.allocate(shipping(lineId, '1'), later(2)).isLeft()).toBe(true)
  })
})
