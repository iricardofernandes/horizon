import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  salesInvoicingRequested,
  salesOrderCancelled,
  salesOrderConfirmed,
  salesOrderPlaced,
  salesQuoteAccepted,
  salesQuoteRejected,
  salesQuoteSent,
  salesShipmentDispatched,
  salesShipmentReturned,
} from './sales'

const placedLine = { lineId: randomUUID(), itemId: randomUUID(), quantity: '2' }
const confirmedLine = {
  ...placedLine,
  description: 'Coffee',
  unitPrice: { amount: '1250', currency: 'BRL' },
  lineTotal: { amount: '2500', currency: 'BRL' },
}

describe('sales event contracts', () => {
  it('places a non-empty order at one fulfillment warehouse', () => {
    expect(
      salesOrderPlaced.payload.safeParse({
        orderId: randomUUID(),
        orderVersion: 1,
        customerId: randomUUID(),
        fulfillmentWarehouseId: randomUUID(),
        lines: [placedLine],
      }).success,
    ).toBe(true)
    expect(
      salesOrderPlaced.payload.safeParse({
        orderId: randomUUID(),
        orderVersion: 1,
        customerId: randomUUID(),
        fulfillmentWarehouseId: randomUUID(),
        lines: [],
      }).success,
    ).toBe(false)
  })

  it('confirms the reservation with immutable line and total snapshots', () => {
    const payload = {
      orderId: randomUUID(),
      orderVersion: 2,
      customerId: randomUUID(),
      reservationId: randomUUID(),
      confirmedAt: '2026-09-14T20:00:00.000Z',
      lines: [confirmedLine],
      total: { amount: '2500', currency: 'BRL' },
    }
    expect(salesOrderConfirmed.payload.safeParse(payload).success).toBe(true)
    expect(salesInvoicingRequested.payload.safeParse(payload).success).toBe(true)
    expect(
      salesOrderConfirmed.payload.safeParse({
        ...payload,
        lines: [{ ...confirmedLine, unitPrice: { amount: '12.50', currency: 'BRL' } }],
      }).success,
    ).toBe(false)
  })

  it('allows cancellation before or after a reservation exists', () => {
    const payload = {
      orderId: randomUUID(),
      orderVersion: 2,
      reservationId: null,
      cancelledAt: '2026-09-14T20:00:00.000Z',
      reason: null,
    }
    expect(salesOrderCancelled.payload.safeParse(payload).success).toBe(true)
    expect(
      salesOrderCancelled.payload.safeParse({ ...payload, reservationId: randomUUID() }).success,
    ).toBe(true)
  })

  it('carries the agreed instalments, and parses a confirmation without them', () => {
    const payload = {
      orderId: randomUUID(),
      orderVersion: 2,
      customerId: randomUUID(),
      reservationId: randomUUID(),
      confirmedAt: '2026-09-14T20:00:00.000Z',
      lines: [confirmedLine],
      total: { amount: '2500', currency: 'BRL' },
    }
    expect(salesOrderConfirmed.payload.safeParse(payload).success).toBe(true)
    expect(
      salesOrderConfirmed.payload.safeParse({
        ...payload,
        installments: [
          { number: 1, dueOn: '2026-10-14', amount: { amount: '1250', currency: 'BRL' } },
          { number: 2, dueOn: '2026-11-13', amount: { amount: '1250', currency: 'BRL' } },
        ],
      }).success,
    ).toBe(true)
    expect(salesOrderConfirmed.payload.safeParse({ ...payload, installments: [] }).success).toBe(
      false,
    )
  })

  it('names the offer and the version of it each quote fact is about', () => {
    const quote = {
      quoteId: randomUUID(),
      quoteRoot: randomUUID(),
      version: 2,
      customerId: randomUUID(),
      total: { amount: '2500', currency: 'BRL' },
    }
    expect(
      salesQuoteSent.payload.safeParse({ ...quote, expiresAt: '2026-09-29T20:00:00.000Z' }).success,
    ).toBe(true)
    expect(salesQuoteAccepted.payload.safeParse(quote).success).toBe(true)
    expect(salesQuoteSent.payload.safeParse(quote).success).toBe(false)
    expect(salesQuoteAccepted.payload.safeParse({ ...quote, version: 0 }).success).toBe(false)
  })

  it('refuses a rejection with no reason in it', () => {
    const rejected = {
      quoteId: randomUUID(),
      quoteRoot: randomUUID(),
      version: 1,
      customerId: randomUUID(),
    }
    expect(
      salesQuoteRejected.payload.safeParse({ ...rejected, reason: 'Too expensive' }).success,
    ).toBe(true)
    expect(salesQuoteRejected.payload.safeParse({ ...rejected, reason: '   ' }).success).toBe(false)
  })

  it('says what a delivery carried, and what the order has still to deliver', () => {
    const payload = {
      orderId: randomUUID(),
      orderVersion: 3,
      shipmentId: randomUUID(),
      customerId: randomUUID(),
      warehouseId: randomUUID(),
      dispatchedBy: 'user:warehouse',
      dispatchedOn: '2026-09-20',
      carrier: 'Correios',
      trackingCode: 'BR123456789',
      lines: [confirmedLine],
      value: { amount: '2500', currency: 'BRL' },
      installments: [
        { number: 1, dueOn: '2026-10-20', amount: { amount: '2500', currency: 'BRL' } },
      ],
      remaining: { amount: '1000', currency: 'BRL' },
      remainingInstallments: [
        { number: 1, dueOn: '2026-10-14', amount: { amount: '1000', currency: 'BRL' } },
      ],
      complete: false,
    }
    expect(salesShipmentDispatched.payload.safeParse(payload).success).toBe(true)
    // A delivery that completes the order leaves nothing expected behind it.
    expect(
      salesShipmentDispatched.payload.safeParse({
        ...payload,
        complete: true,
        remaining: { amount: '0', currency: 'BRL' },
        remainingInstallments: [],
      }).success,
    ).toBe(true)
    // Something must have left the warehouse, and it must be worth a schedule.
    expect(salesShipmentDispatched.payload.safeParse({ ...payload, lines: [] }).success).toBe(false)
    expect(
      salesShipmentDispatched.payload.safeParse({ ...payload, installments: [] }).success,
    ).toBe(false)
  })

  it('refuses a return with no reason, and names the delivery it undoes', () => {
    const payload = {
      orderId: randomUUID(),
      orderVersion: 4,
      shipmentId: randomUUID(),
      customerId: randomUUID(),
      warehouseId: randomUUID(),
      returnedBy: 'user:warehouse',
      returnedOn: '2026-09-25',
      reason: 'Damaged in transit',
      lines: [confirmedLine],
      value: { amount: '2500', currency: 'BRL' },
      remaining: { amount: '3500', currency: 'BRL' },
      remainingInstallments: [
        { number: 1, dueOn: '2026-10-14', amount: { amount: '3500', currency: 'BRL' } },
      ],
    }
    expect(salesShipmentReturned.payload.safeParse(payload).success).toBe(true)
    expect(salesShipmentReturned.payload.safeParse({ ...payload, reason: ' ' }).success).toBe(false)
  })
})
