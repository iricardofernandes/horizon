import { randomUUID } from 'node:crypto'
import { snapshotOf } from 'test/support/snapshot-of'
import { ServiceOrder } from './entities/service-order'
import type { ConfirmedOrderLine } from './events/sales-events'
import { discountShare } from './services/service-billing'
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
const money = (amount: bigint) => Money.fromAmount(amount, brl)
const quantity = (value: string) => unwrap(Quantity.create(value))
const day = (value: string) => unwrap(BusinessDate.create(value))
const now = new Date('2026-09-20T12:00:00.000Z')

function line(unitPrice: bigint, units: string, name = 'Implantação'): ConfirmedOrderLine {
  return {
    lineId: randomUUID(),
    itemId: randomUUID(),
    quantity: quantity(units),
    description: unwrap(LineDescription.create(name)),
    unitPrice: money(unitPrice),
    lineTotal: money(unitPrice).multiply(quantity(units)),
  }
}

function open(lines: readonly ConfirmedOrderLine[], discount = 0n, days = [0]) {
  return unwrap(
    ServiceOrder.open({
      tenantId: randomUUID(),
      customerId: randomUUID(),
      quoteId: null,
      currency: brl,
      lines,
      discount: money(discount),
      paymentTerms: unwrap(PaymentTerms.create(days)),
      notes: null,
      scheduledFor: null,
      openedOn: day('2026-09-01'),
      createdBy: 'ana',
      now,
    }),
  )
}

function deliver(
  order: ServiceOrder,
  lines: readonly { lineId: string; quantity: string }[] | 'outstanding',
  performedOn = '2026-09-20',
) {
  return order.deliver(
    {
      deliveryId: randomUUID(),
      lines:
        lines === 'outstanding'
          ? lines
          : lines.map((entry) => ({ lineId: entry.lineId, quantity: quantity(entry.quantity) })),
      performedOn: day(performedOn),
      today: day('2026-09-20'),
      deliveredBy: 'ana',
      entryId: () => randomUUID(),
    },
    now,
  )
}

const reason = unwrap(Reason.create('O cliente desistiu da etapa'))

describe('service orders', () => {
  it('delivers work only once started, and bills each delivery once', () => {
    const setup = line(10_000n, '3')
    const order = open([setup], 0n, [0, 30])
    expect(deliver(order, 'outstanding').isLeft()).toBe(true)
    unwrap(order.start(now))
    expect(order.start(now).isLeft()).toBe(true)

    const first = unwrap(deliver(order, [{ lineId: setup.lineId, quantity: '1' }]))
    expect(first.value.amount).toBe(10_000n)
    expect(order.status).toBe('in_progress')
    const [delivered] = order.pullDomainEvents()
    expect(delivered?.eventType).toBe('sales.service.delivered')
    expect(delivered?.payloadOf()).toMatchObject({
      deliveryId: first.id,
      performedOn: '2026-09-20',
      competence: '2026-09',
      value: { amount: '10000', currency: 'BRL' },
      installments: [
        { number: 1, dueOn: '2026-09-20', amount: { amount: '5000', currency: 'BRL' } },
        { number: 2, dueOn: '2026-10-20', amount: { amount: '5000', currency: 'BRL' } },
      ],
      complete: false,
    })

    const rest = unwrap(deliver(order, 'outstanding'))
    expect(rest.entries[0]?.quantity.toString()).toBe('2')
    expect(order.status).toBe('completed')
    expect(order.pullDomainEvents()[0]?.payloadOf()).toMatchObject({ complete: true })
    expect(deliver(order, 'outstanding').isLeft()).toBe(true)
  })

  it('refuses work in the future, or beyond what is owed', () => {
    const setup = line(10_000n, '1')
    const order = open([setup])
    unwrap(order.start(now))
    // Today in any time zone is at most a day past the UTC one.
    expect(deliver(order, 'outstanding', '2026-09-22').isLeft()).toBe(true)
    expect(deliver(order, [{ lineId: setup.lineId, quantity: '2' }]).isLeft()).toBe(true)
    expect(deliver(order, [{ lineId: randomUUID(), quantity: '1' }]).isLeft()).toBe(true)
    expect(order.pullDomainEvents()).toHaveLength(0)
    // Work recorded after the fact may predate the order.
    expect(deliver(order, 'outstanding', '2026-08-31').isRight()).toBe(true)
  })

  it('adds deliveries up to the total exactly, with the discount spread across them', () => {
    const a = line(3_333n, '1', 'Análise')
    const b = line(3_333n, '1', 'Desenvolvimento')
    const c = line(3_334n, '1', 'Treinamento')
    const order = open([a, b, c], 1_001n)
    unwrap(order.start(now))
    const values = [a, b, c].map(
      (target) => unwrap(deliver(order, [{ lineId: target.lineId, quantity: '1' }])).value.amount,
    )
    expect(values.reduce((sum, value) => sum + value, 0n)).toBe(order.total().amount)
    expect(order.total().amount).toBe(8_999n)
    expect(order.billed().amount).toBe(8_999n)
  })

  it('spreads one delivery across its lines, the last line taking the remainder', () => {
    const a = line(1_000n, '1')
    const b = line(2_000n, '1')
    const order = open([a, b], 1_000n)
    unwrap(order.start(now))
    const delivery = unwrap(deliver(order, 'outstanding'))
    expect(delivery.entries.map((entry) => entry.amount.amount)).toEqual([666n, 1_334n])
    expect(delivery.value.amount).toBe(2_000n)
  })

  it('cancels a delivery without erasing it, and owes its work again', () => {
    const setup = line(10_000n, '2')
    const order = open([setup])
    unwrap(order.start(now))
    const first = unwrap(deliver(order, 'outstanding'))
    order.pullDomainEvents()
    expect(order.status).toBe('completed')
    unwrap(order.accept('cliente', now))
    expect(order.cancel(reason, now).isLeft()).toBe(true)

    unwrap(
      order.cancelDelivery(
        { deliveryId: first.id, reason, cancelledOn: day('2026-09-21'), cancelledBy: 'ana' },
        now,
      ),
    )
    expect(order.status).toBe('in_progress')
    expect(order.billed().isZero()).toBe(true)
    expect(order.outstanding()[0]?.quantity.toString()).toBe('2')
    const [cancelled] = order.pullDomainEvents()
    expect(cancelled?.payloadOf()).toMatchObject({
      deliveryId: first.id,
      competence: '2026-09',
      entryIds: first.entries.map((entry) => entry.entryId),
      cancelledOn: '2026-09-21',
      reason: 'O cliente desistiu da etapa',
    })
    expect(
      order
        .cancelDelivery(
          { deliveryId: first.id, reason, cancelledOn: day('2026-09-21'), cancelledBy: 'ana' },
          now,
        )
        .isLeft(),
    ).toBe(true)
    expect(snapshotOf(order).deliveries).toHaveLength(1)

    const again = unwrap(deliver(order, 'outstanding'))
    expect(again.value.amount).toBe(20_000n)
    unwrap(
      order.cancelDelivery(
        { deliveryId: again.id, reason, cancelledOn: day('2026-09-21'), cancelledBy: 'ana' },
        now,
      ),
    )
    unwrap(order.cancel(reason, now))
    expect(order.status).toBe('cancelled')
  })

  it('refuses a discount deeper than the services and a delivery worth nothing', () => {
    expect(
      ServiceOrder.open({
        tenantId: randomUUID(),
        customerId: randomUUID(),
        quoteId: null,
        currency: brl,
        lines: [line(100n, '1')],
        discount: money(101n),
        paymentTerms: PaymentTerms.immediate(),
        notes: null,
        scheduledFor: null,
        openedOn: day('2026-09-01'),
        createdBy: 'ana',
        now,
      }).isLeft(),
    ).toBe(true)
    const free = open([line(100n, '1')], 100n)
    unwrap(free.start(now))
    expect(deliver(free, 'outstanding').isLeft()).toBe(true)
  })
})

describe('discount split of a proposal', () => {
  it('gives the services their share rounded down, and the goods the rest', () => {
    expect(discountShare(money(1_000n), money(3_000n), money(1_000n)).amount).toBe(333n)
    expect(discountShare(money(1_000n), money(3_000n), money(0n)).amount).toBe(0n)
    expect(discountShare(money(1_000n), money(0n), money(0n)).amount).toBe(0n)
  })
})
