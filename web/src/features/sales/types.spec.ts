import { describe, expect, it } from 'vitest'
import {
  awaitingApproval,
  currentVersions,
  deliverable,
  historyOf,
  type Order,
  type OrderLine,
  outstandingOf,
  type Quote,
  shippedShare,
} from './types'

function quote(values: Partial<Quote> & Pick<Quote, 'id' | 'rootId' | 'version'>): Quote {
  return {
    customerId: 'customer',
    currency: 'BRL',
    sellerId: null,
    discount: '0',
    freight: '0',
    carrier: null,
    paymentTermDays: [30],
    notes: null,
    net: '1000',
    total: '1000',
    status: 'draft',
    approvalState: 'none',
    approvalRequestedBy: null,
    approvalRequestedAt: null,
    approvalDecidedBy: null,
    approvalDecidedAt: null,
    approvalReason: null,
    expiresAt: '2026-10-01T00:00:00.000Z',
    supersedes: null,
    supersededBy: null,
    closureReason: null,
    orderId: null,
    sentAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lines: [],
    ...values,
  }
}

function line(values: Partial<OrderLine>): OrderLine {
  return { lineId: 'line', itemId: 'item', quantity: '10', shipped: '0', allocated: '0', ...values }
}

function order(values: Partial<Order> & Pick<Order, 'id'>): Order {
  return {
    customerId: 'customer',
    fulfillmentWarehouseId: 'warehouse',
    quoteId: null,
    sellerId: null,
    currency: 'BRL',
    discount: '0',
    freight: '0',
    carrier: null,
    paymentTermDays: [30],
    issuedOn: '2026-09-01',
    notes: null,
    status: 'confirmed',
    fulfillment: 'unfulfilled',
    shipments: 0,
    confirmedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    reservationId: null,
    total: { amount: '1000', currency: 'BRL' },
    createdAt: '2026-09-01T00:00:00.000Z',
    requestedLines: [],
    confirmedLines: [],
    ...values,
  }
}

describe('an offer negotiated in versions', () => {
  const negotiation = [
    quote({ id: 'v1', rootId: 'root', version: 1, status: 'superseded' }),
    quote({ id: 'v2', rootId: 'root', version: 2, status: 'sent' }),
    quote({ id: 'other', rootId: 'other', version: 1, createdAt: '2026-09-05T00:00:00.000Z' }),
  ]

  it('shows one card per offer, on its newest version, newest offer first', () => {
    expect(currentVersions(negotiation).map((row) => row.id)).toEqual(['other', 'v2'])
  })

  it('reads a negotiation backwards, from where it got to', () => {
    expect(historyOf(negotiation, 'root').map((row) => row.version)).toEqual([2, 1])
  })

  it('never offers somebody the decision on their own discount', () => {
    const waiting = [
      quote({
        id: 'mine',
        rootId: 'mine',
        version: 1,
        status: 'pending',
        approvalState: 'pending',
        approvalRequestedBy: 'me',
      }),
      quote({
        id: 'theirs',
        rootId: 'theirs',
        version: 1,
        status: 'pending',
        approvalState: 'pending',
        approvalRequestedBy: 'somebody',
      }),
    ]
    expect(awaitingApproval(waiting, 'me').map((row) => row.id)).toEqual(['theirs'])
  })

  it('leaves a superseded version out of the queue, however it was left', () => {
    const replaced = [
      quote({
        id: 'v1',
        rootId: 'root',
        version: 1,
        status: 'pending',
        approvalState: 'pending',
        approvalRequestedBy: 'somebody',
      }),
      quote({ id: 'v2', rootId: 'root', version: 2, status: 'draft' }),
    ]
    expect(awaitingApproval(replaced, 'me')).toEqual([])
  })
})

describe('what an order still owes', () => {
  it('counts what has gone and what another box is already holding', () => {
    expect(outstandingOf(line({ quantity: '10', shipped: '4', allocated: '2' }))).toBe('4')
    expect(outstandingOf(line({ quantity: '10', shipped: '10' }))).toBe('0')
    // Nothing is ever owed twice: an over-allocated line owes nothing, never a negative.
    expect(outstandingOf(line({ quantity: '10', shipped: '6', allocated: '6' }))).toBe('0')
    expect(outstandingOf(line({ quantity: '1.5', shipped: '0.25' }))).toBe('1.25')
  })

  it('reports how much of an order has left as a share of its quantities', () => {
    expect(shippedShare([line({ quantity: '10', shipped: '4' })])).toBe(40)
    expect(shippedShare([])).toBe(0)
  })

  it('offers the warehouse only orders with goods still to take off the shelf', () => {
    const orders = [
      order({ id: 'confirmed' }),
      order({ id: 'part', fulfillment: 'partial' }),
      order({ id: 'done', fulfillment: 'fulfilled' }),
      order({ id: 'placed', status: 'placed' }),
    ]
    expect(deliverable(orders).map((row) => row.id)).toEqual(['confirmed', 'part'])
  })
})
