import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { PurchaseOrder } from './entities/purchase-order'
import { PurchaseRequisition } from './entities/purchase-requisition'
import { SupplierQuotation } from './entities/supplier-quotation'
import { noCharges, priceLines, totalOf } from './services/pricing'
import {
  BusinessDate,
  Currency,
  DocumentNumber,
  LineDescription,
  Money,
  PartyName,
  PaymentTerms,
  Quantity,
  Reason,
} from './value-objects/procurement-values'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const tenantId = '0192a3b4-0000-7000-8000-0000000000ff'
const now = new Date('2026-09-16T12:00:00Z')
const brl = valid(Currency.create('BRL'))
const money = (amount: number | bigint) => Money.of(BigInt(amount), brl)
const date = (value: string) => valid(BusinessDate.create(value))
const quantity = (value: string) => valid(Quantity.create(value))
const reason = valid(Reason.create('The supplier cannot deliver in time'))
const supplierName = valid(PartyName.create('Papelaria Central Ltda'))

const BUYER = 'user:buyer'
const MANAGER = 'user:manager'
const WAREHOUSE = '0192a3b4-0000-7000-8000-00000000aaaa'
const PAPER = '0192a3b4-0000-7000-8000-00000000bbbb'
const SUPPLIER = '0192a3b4-0000-7000-8000-00000000dddd'

const line = (lineId: string, itemId: string, qty: string) => ({
  lineId,
  itemId,
  description: valid(LineDescription.create(`Item ${itemId.slice(-4)}`)),
  quantity: quantity(qty),
})

const LINE_A = '0192a3b4-0000-7000-8000-000000000001'
const LINE_B = '0192a3b4-0000-7000-8000-000000000002'

function requisition(lines = [line(LINE_A, PAPER, '10')]) {
  return valid(
    PurchaseRequisition.open({
      tenantId,
      requestedBy: BUYER,
      warehouseId: WAREHOUSE,
      neededBy: date('2026-09-30'),
      justification: null,
      lines,
      now,
    }),
  )
}

function submitted() {
  const opened = requisition()
  valid(opened.submit(BUYER, now))
  return opened
}

function approved() {
  const open = submitted()
  valid(open.approve(MANAGER, now))
  return open
}

function order(options: { total?: number; terms?: number[] } = {}) {
  return valid(
    PurchaseOrder.draft({
      tenantId,
      supplier: { supplierId: SUPPLIER, name: supplierName },
      requisitionId: null,
      quotationId: null,
      warehouseId: WAREHOUSE,
      currency: brl,
      lines: [
        {
          ...line(LINE_A, PAPER, '10'),
          unitPrice: money(options.total === undefined ? 2500 : options.total / 10),
        },
      ],
      charges: noCharges(brl),
      paymentTerms: valid(PaymentTerms.create(options.terms ?? [30])),
      issuedOn: date('2026-09-16'),
      expectedOn: date('2026-09-26'),
      notes: null,
      now,
    }),
  )
}

describe('purchase requisition', () => {
  it('asks for at least one item, once each, in a positive quantity', () => {
    expect(PurchaseRequisition.open({ ...openInput(), lines: [] }).isLeft()).toBe(true)
    expect(
      PurchaseRequisition.open({
        ...openInput(),
        lines: [line(LINE_A, PAPER, '10'), line(LINE_B, PAPER, '5')],
      }).isLeft(),
    ).toBe(true)
    expect(
      PurchaseRequisition.open({ ...openInput(), lines: [line(LINE_A, PAPER, '0')] }).isLeft(),
    ).toBe(true)
    expect(requisition().status).toBe('draft')
  })

  it('is revised only while it is a draft', () => {
    const open = requisition()
    expect(
      valid(
        open.revise(
          { neededBy: date('2026-10-05'), justification: null, lines: [line(LINE_A, PAPER, '20')] },
          now,
        ),
      ),
    ).toBeUndefined()
    valid(open.submit(BUYER, now))
    const refused = open.revise(
      { neededBy: date('2026-10-05'), justification: null, lines: [line(LINE_A, PAPER, '20')] },
      now,
    )
    expect(refused.isLeft()).toBe(true)
  })

  it('is decided by somebody other than whoever submitted it', () => {
    const open = submitted()
    expect(open.approve(BUYER, now).isLeft()).toBe(true)
    expect(open.reject(BUYER, reason, now).isLeft()).toBe(true)
    valid(open.approve(MANAGER, now))
    expect(open.status).toBe('approved')
  })

  it('announces what it asks for, and what was decided', () => {
    const open = requisition()
    valid(open.submit(BUYER, now))
    valid(open.approve(MANAGER, now))
    const types = open.pullDomainEvents().map((event) => event.eventType)
    expect(types).toEqual(['procurement.requisition.submitted', 'procurement.requisition.approved'])
  })

  it('becomes an order once, and is then beyond cancelling', () => {
    const open = approved()
    valid(open.markOrdered('0192a3b4-0000-7000-8000-00000000eeee', now))
    expect(open.status).toBe('ordered')
    expect(open.markOrdered('0192a3b4-0000-7000-8000-00000000ffff', now).isLeft()).toBe(true)
    expect(open.cancel(reason, now).isLeft()).toBe(true)
  })

  it('carries a draft with no decision through its snapshot', () => {
    const snapshot = snapshotOf(requisition())
    expect(snapshot.decidedBy).toBeNull()
    expect(snapshot.lines).toHaveLength(1)
    expect(snapshot.lines[0]?.quantity).toBe('10')
  })
})

function openInput() {
  return {
    tenantId,
    requestedBy: BUYER,
    warehouseId: WAREHOUSE,
    neededBy: date('2026-09-30'),
    justification: null,
    lines: [line(LINE_A, PAPER, '10')],
    now,
  }
}

describe('pricing', () => {
  it('derives every line total from the price and the quantity', () => {
    const lines = valid(
      priceLines([{ ...line(LINE_A, PAPER, '2.5'), unitPrice: money(1000) }], noCharges(brl), brl),
    )
    expect(lines[0]?.lineTotal.amount).toBe(2500n)
  })

  it('adds tax and charges and takes the discount off, in that order', () => {
    const charges = {
      tax: money(100),
      freight: money(500),
      otherCharges: money(50),
      discount: money(150),
    }
    const lines = valid(
      priceLines([{ ...line(LINE_A, PAPER, '1'), unitPrice: money(1000) }], charges, brl),
    )
    expect(totalOf(lines, charges, brl).amount).toBe(1500n)
  })

  it('refuses a discount larger than what is being charged, and a document worth nothing', () => {
    const tooMuch = {
      tax: money(0),
      freight: money(0),
      otherCharges: money(0),
      discount: money(2000),
    }
    expect(
      priceLines([{ ...line(LINE_A, PAPER, '1'), unitPrice: money(1000) }], tooMuch, brl).isLeft(),
    ).toBe(true)
    const free = { ...noCharges(brl) }
    expect(
      priceLines([{ ...line(LINE_A, PAPER, '1'), unitPrice: money(0) }], free, brl).isLeft(),
    ).toBe(true)
  })

  it('refuses a line priced in another currency than the document', () => {
    const usd = valid(Currency.create('USD'))
    expect(
      priceLines(
        [{ ...line(LINE_A, PAPER, '1'), unitPrice: Money.of(1000n, usd) }],
        noCharges(brl),
        brl,
      ).isLeft(),
    ).toBe(true)
  })
})

describe('payment terms', () => {
  it('splits a total that does not divide evenly without losing a minor unit', () => {
    const terms = valid(PaymentTerms.create([0, 30, 60]))
    const schedule = terms.scheduleOf(money(1000), date('2026-09-16'))
    expect(schedule.map((part) => part.amount.amount)).toEqual([334n, 333n, 333n])
    expect(schedule.map((part) => part.dueOn.value)).toEqual([
      '2026-09-16',
      '2026-10-16',
      '2026-11-15',
    ])
  })

  it('refuses terms that go backwards or repeat a day', () => {
    expect(PaymentTerms.create([30, 15]).isLeft()).toBe(true)
    expect(PaymentTerms.create([30, 30]).isLeft()).toBe(true)
    expect(PaymentTerms.create([]).isLeft()).toBe(true)
  })
})

describe('supplier quotation', () => {
  function quotation(options: { validUntil?: string; unitPrice?: number } = {}) {
    return SupplierQuotation.record({
      tenantId,
      requisitionId: '0192a3b4-0000-7000-8000-000000000aaa',
      supplierId: SUPPLIER,
      reference: valid(DocumentNumber.create('COT-2026-117')),
      quotedOn: date('2026-09-16'),
      validUntil: options.validUntil === undefined ? null : date(options.validUntil),
      currency: brl,
      lines: [{ ...line(LINE_A, PAPER, '10'), unitPrice: money(options.unitPrice ?? 2500) }],
      charges: noCharges(brl),
      paymentTerms: valid(PaymentTerms.create([30])),
      leadTimeDays: 10,
      notes: null,
      recordedBy: BUYER,
      now,
    })
  }

  it('totals the goods and the charges it was offered with', () => {
    expect(valid(quotation()).total().amount).toBe(25_000n)
  })

  it('cannot expire before it was given', () => {
    expect(quotation({ validUntil: '2026-09-15' }).isLeft()).toBe(true)
  })

  it('is worth ordering from until the day it expires, and not after', () => {
    const offer = valid(quotation({ validUntil: '2026-09-30' }))
    expect(offer.isValidOn(date('2026-09-30'))).toBe(true)
    expect(offer.isValidOn(date('2026-10-01'))).toBe(false)
  })

  it('is selected once, and a selected offer is never declined', () => {
    const offer = valid(quotation())
    valid(offer.select(now))
    expect(offer.status).toBe('selected')
    expect(offer.select(now).isLeft()).toBe(true)
    expect(offer.decline(now).isLeft()).toBe(true)
  })

  it('declines idempotently, because setting an offer aside twice changes nothing', () => {
    const offer = valid(quotation())
    valid(offer.decline(now))
    expect(valid(offer.decline(now))).toBeUndefined()
  })
})

describe('purchase order', () => {
  it('commits on the spot when the workspace asks nobody, and records that nobody was asked', () => {
    const placed = order()
    valid(placed.place(BUYER, now, { approvalRequired: false }))
    expect(placed.status).toBe('approved')
    expect(placed.approvalState).toBe('not-required')
    expect(placed.pullDomainEvents().map((event) => event.eventType)).toEqual([
      'procurement.order.placed',
      'procurement.order.approved',
    ])
  })

  it('waits for a second person above the threshold, and never for the person who placed it', () => {
    const placed = order()
    valid(placed.place(BUYER, now, { approvalRequired: true }))
    expect(placed.status).toBe('pending')
    expect(placed.approve(BUYER, now).isLeft()).toBe(true)
    valid(placed.approve(MANAGER, now))
    expect(placed.status).toBe('approved')
  })

  it('is revised only as a draft', () => {
    const drafted = order()
    valid(drafted.place(BUYER, now, { approvalRequired: true }))
    const refused = drafted.revise(
      {
        lines: [{ ...line(LINE_A, PAPER, '20'), unitPrice: money(2500) }],
        charges: noCharges(brl),
        paymentTerms: valid(PaymentTerms.create([30])),
        expectedOn: date('2026-09-26'),
        notes: null,
      },
      now,
    )
    expect(refused.isLeft()).toBe(true)
  })

  it('cannot expect delivery before it was issued', () => {
    const refused = PurchaseOrder.draft({
      tenantId,
      supplier: { supplierId: SUPPLIER, name: supplierName },
      requisitionId: null,
      quotationId: null,
      warehouseId: WAREHOUSE,
      currency: brl,
      lines: [{ ...line(LINE_A, PAPER, '1'), unitPrice: money(1000) }],
      charges: noCharges(brl),
      paymentTerms: PaymentTerms.immediate(),
      issuedOn: date('2026-09-16'),
      expectedOn: date('2026-09-15'),
      notes: null,
      now,
    })
    expect(refused.isLeft()).toBe(true)
  })

  it('publishes the dated schedule its terms imply, adding up to the total', () => {
    const placed = order({ total: 10_000, terms: [0, 30, 60] })
    valid(placed.place(BUYER, now, { approvalRequired: false }))
    const approvedEvent = placed
      .pullDomainEvents()
      .find((event) => event.eventType === 'procurement.order.approved')
    const installments = approvedEvent?.payloadOf().installments as {
      dueOn: string
      amount: { amount: string }
    }[]
    expect(installments.map((one) => one.dueOn)).toEqual(['2026-09-16', '2026-10-16', '2026-11-15'])
    const sum = installments.reduce((total, one) => total + BigInt(one.amount.amount), 0n)
    expect(sum).toBe(placed.total().amount)
  })

  it('is cancelled once, and says whether anything had been committed', () => {
    const placed = order()
    valid(placed.place(BUYER, now, { approvalRequired: false }))
    placed.pullDomainEvents()
    valid(placed.cancel(reason, now))
    const cancelled = placed.pullDomainEvents()[0]
    expect(cancelled?.payloadOf().wasApproved).toBe(true)
    expect(placed.cancel(reason, now).isLeft()).toBe(true)
  })

  it('keeps its own copy of the supplier name and every line', () => {
    const snapshot = snapshotOf(order())
    expect(snapshot.supplierName).toBe('Papelaria Central Ltda')
    expect(snapshot.lines[0]?.lineTotal).toBe('25000')
    expect(snapshot.total).toBe('25000')
  })
})

describe('receiving', () => {
  const RECEIVED_ON = date('2026-09-20')

  /** Ten units at 25.00, plus 100.00 of freight: a total that does not divide evenly. */
  function delivering(terms: number[] = [30]) {
    return valid(
      PurchaseOrder.draft({
        tenantId,
        supplier: { supplierId: SUPPLIER, name: supplierName },
        requisitionId: null,
        quotationId: null,
        warehouseId: WAREHOUSE,
        currency: brl,
        lines: [{ ...line(LINE_A, PAPER, '10'), unitPrice: money(2500) }],
        charges: { ...noCharges(brl), freight: money(10_000) },
        paymentTerms: valid(PaymentTerms.create(terms)),
        issuedOn: date('2026-09-16'),
        expectedOn: date('2026-09-26'),
        notes: null,
        now,
      }),
    )
  }

  function approvedOrder(terms?: number[]) {
    const order = delivering(terms)
    valid(order.place(BUYER, now, { approvalRequired: false }))
    order.pullDomainEvents()
    return order
  }

  it('carries the order charges in proportion to the goods in the delivery', () => {
    const order = approvedOrder()
    const half = valid(
      order.receive(
        {
          receivedOn: RECEIVED_ON,
          lines: [{ lineId: LINE_A, quantity: quantity('5') }],
          override: null,
        },
        now,
      ),
    )
    // Half the goods carry half the freight: 12500 + 5000.
    expect(half.value.amount).toBe(17_500n)
    expect(half.remaining.amount).toBe(17_500n)
    expect(half.complete).toBe(false)
  })

  it('leaves nothing behind when the last delivery completes the order', () => {
    const order = approvedOrder()
    const first = valid(
      order.receive(
        {
          receivedOn: RECEIVED_ON,
          lines: [{ lineId: LINE_A, quantity: quantity('3') }],
          override: null,
        },
        now,
      ),
    )
    const second = valid(
      order.receive(
        {
          receivedOn: RECEIVED_ON,
          lines: [{ lineId: LINE_A, quantity: quantity('7') }],
          override: null,
        },
        now,
      ),
    )
    expect(first.value.plus(second.value).amount).toBe(order.total().amount)
    expect(second.remaining.isZero()).toBe(true)
    expect(second.complete).toBe(true)
    expect(order.status).toBe('received')
  })

  it('refuses more than was ordered until somebody says why', () => {
    const order = approvedOrder()
    const refused = order.receive(
      {
        receivedOn: RECEIVED_ON,
        lines: [{ lineId: LINE_A, quantity: quantity('11') }],
        override: null,
      },
      now,
    )
    expect(refused.isLeft()).toBe(true)
    const accepted = valid(
      order.receive(
        {
          receivedOn: RECEIVED_ON,
          lines: [{ lineId: LINE_A, quantity: quantity('11') }],
          override: reason,
        },
        now,
      ),
    )
    // More arrived than was ordered, so more is owed than the order total, and nothing
    // is still expected.
    expect(accepted.value.amount).toBeGreaterThan(order.total().amount)
    expect(accepted.remaining.isZero()).toBe(true)
    expect(accepted.overReceipt).toBe(true)
  })

  it('will not take delivery against an order nobody committed to', () => {
    const drafted = delivering()
    expect(
      drafted
        .receive(
          {
            receivedOn: RECEIVED_ON,
            lines: [{ lineId: LINE_A, quantity: quantity('1') }],
            override: null,
          },
          now,
        )
        .isLeft(),
    ).toBe(true)
  })

  it('puts back what a return takes away', () => {
    const order = approvedOrder()
    valid(
      order.receive(
        {
          receivedOn: RECEIVED_ON,
          lines: [{ lineId: LINE_A, quantity: quantity('10') }],
          override: null,
        },
        now,
      ),
    )
    expect(order.status).toBe('received')
    const undone = valid(order.unreceive([{ lineId: LINE_A, quantity: quantity('10') }], now))
    expect(undone.remaining.amount).toBe(order.total().amount)
    expect(order.status).toBe('approved')
    expect(order.unreceive([{ lineId: LINE_A, quantity: quantity('1') }], now).isLeft()).toBe(true)
  })

  it('cannot be cancelled once goods have arrived, only closed', () => {
    const order = approvedOrder()
    valid(
      order.receive(
        {
          receivedOn: RECEIVED_ON,
          lines: [{ lineId: LINE_A, quantity: quantity('1') }],
          override: null,
        },
        now,
      ),
    )
    expect(order.cancel(reason, now).isLeft()).toBe(true)
    valid(order.close(reason, now))
    expect(order.status).toBe('closed')
    const closed = order.pullDomainEvents().at(-1)
    expect(closed?.eventType).toBe('procurement.order.closed')
    expect(closed?.payloadOf().complete).toBe(false)
  })

  it('splits what a delivery owes across the order payment terms', () => {
    const order = approvedOrder([0, 30])
    const plan = valid(
      order.receive(
        {
          receivedOn: RECEIVED_ON,
          lines: [{ lineId: LINE_A, quantity: quantity('10') }],
          override: null,
        },
        now,
      ),
    )
    expect(plan.installments.map((part) => part.dueOn.value)).toEqual(['2026-09-20', '2026-10-20'])
    const sum = plan.installments.reduce((total, part) => total + part.amount.amount, 0n)
    expect(sum).toBe(plan.value.amount)
  })
})
