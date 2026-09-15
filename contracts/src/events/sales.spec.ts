import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  salesInvoicingRequested,
  salesOrderCancelled,
  salesOrderConfirmed,
  salesOrderPlaced,
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
})
