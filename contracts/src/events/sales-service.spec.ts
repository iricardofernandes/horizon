import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { financialReceivablePosted } from './financial'
import { salesServiceDelivered, salesServiceDeliveryCancelled } from './sales'

const brl = (amount: string) => ({ amount, currency: 'BRL' })
const delivered = {
  serviceOrderId: randomUUID(),
  deliveryId: randomUUID(),
  customerId: randomUUID(),
  performedOn: '2026-09-20',
  competence: '2026-09',
  deliveredBy: 'user:operator',
  lines: [
    {
      entryId: randomUUID(),
      lineId: randomUUID(),
      itemId: randomUUID(),
      description: 'Implantação assistida',
      quantity: '1',
      unitPrice: brl('150000'),
      amount: brl('142500'),
    },
  ],
  value: brl('142500'),
  installments: [{ number: 1, dueOn: '2026-10-20', amount: brl('142500') }],
  complete: true,
}

describe('sales service event contracts', () => {
  it('publishes a delivery with its lines, competence month and installments', () => {
    expect(salesServiceDelivered.payload.safeParse(delivered).success).toBe(true)
    expect(salesServiceDelivered.payload.safeParse({ ...delivered, lines: [] }).success).toBe(false)
    expect(
      salesServiceDelivered.payload.safeParse({ ...delivered, competence: '2026-13' }).success,
    ).toBe(false)
    expect(
      salesServiceDelivered.payload.safeParse({ ...delivered, installments: [] }).success,
    ).toBe(false)
  })

  it('cancels a delivery naming its lines and the reason', () => {
    const cancelled = {
      serviceOrderId: delivered.serviceOrderId,
      deliveryId: delivered.deliveryId,
      customerId: delivered.customerId,
      competence: '2026-09',
      entryIds: delivered.lines.map((line) => line.entryId),
      cancelledOn: '2026-09-21',
      reason: 'O cliente cancelou a implantação',
    }
    expect(salesServiceDeliveryCancelled.payload.safeParse(cancelled).success).toBe(true)
    expect(
      salesServiceDeliveryCancelled.payload.safeParse({ ...cancelled, reason: ' ' }).success,
    ).toBe(false)
    expect(
      salesServiceDeliveryCancelled.payload.safeParse({ ...cancelled, entryIds: [] }).success,
    ).toBe(false)
  })

  it('lets a receivable name the service delivery it came from', () => {
    const origin = { type: 'sales-service-delivery', documentId: delivered.deliveryId }
    const parsed = financialReceivablePosted.payload.shape.origin.safeParse(origin)
    expect(parsed.success).toBe(true)
  })
})
