import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  procurementOrderApproved,
  procurementOrderCancelled,
  procurementOrderPlaced,
  procurementRequisitionApproved,
  procurementRequisitionRejected,
  procurementRequisitionSubmitted,
} from './procurement'

const brl = (amount: string) => ({ amount, currency: 'BRL' })

const orderLine = () => ({
  lineId: randomUUID(),
  itemId: randomUUID(),
  description: 'Papel A4 75g, resma',
  quantity: '10',
  unitPrice: brl('2500'),
  lineTotal: brl('25000'),
})

const commercial = () => ({
  supplierId: randomUUID(),
  supplierName: 'Papelaria Central Ltda',
  requisitionId: randomUUID(),
  warehouseId: randomUUID(),
  issuedOn: '2026-09-10',
  expectedOn: '2026-09-20',
  total: brl('25000'),
  lines: [orderLine()],
})

describe('procurement event contracts', () => {
  it('submits a requisition with quantities and no prices', () => {
    const submitted = {
      requisitionId: randomUUID(),
      requisitionVersion: 1,
      requestedBy: 'user:buyer',
      submittedBy: 'user:buyer',
      warehouseId: randomUUID(),
      neededBy: '2026-09-30',
      lines: [{ lineId: randomUUID(), itemId: randomUUID(), quantity: '10' }],
    }
    expect(procurementRequisitionSubmitted.payload.safeParse(submitted).success).toBe(true)
    expect(
      procurementRequisitionSubmitted.payload.safeParse({ ...submitted, lines: [] }).success,
    ).toBe(false)
    expect(
      procurementRequisitionSubmitted.payload.safeParse({ ...submitted, neededBy: '30/09/2026' })
        .success,
    ).toBe(false)
  })

  it('decides a requisition, and a rejection says why', () => {
    const requisitionId = randomUUID()
    expect(
      procurementRequisitionApproved.payload.safeParse({
        requisitionId,
        requisitionVersion: 2,
        approvedBy: 'user:manager',
        warehouseId: randomUUID(),
      }).success,
    ).toBe(true)
    expect(
      procurementRequisitionRejected.payload.safeParse({
        requisitionId,
        requisitionVersion: 2,
        rejectedBy: 'user:manager',
        reason: 'Stock on hand covers this',
      }).success,
    ).toBe(true)
    expect(
      procurementRequisitionRejected.payload.safeParse({
        requisitionId,
        requisitionVersion: 2,
        rejectedBy: 'user:manager',
        reason: 'no',
      }).success,
    ).toBe(false)
  })

  it('places an order that carries everything needed to act on it', () => {
    const placed = {
      orderId: randomUUID(),
      orderVersion: 1,
      placedBy: 'user:buyer',
      approvalRequired: true,
      ...commercial(),
    }
    expect(procurementOrderPlaced.payload.safeParse(placed).success).toBe(true)
    expect(procurementOrderPlaced.payload.safeParse({ ...placed, lines: [] }).success).toBe(false)
    expect(
      procurementOrderPlaced.payload.safeParse({
        ...placed,
        total: { amount: '250.00', currency: 'BRL' },
      }).success,
    ).toBe(false)
  })

  it('approves an order with a dated payment schedule', () => {
    const approved = {
      orderId: randomUUID(),
      orderVersion: 2,
      approvedBy: 'user:manager',
      approvalRequired: true,
      installments: [
        { number: 1, dueOn: '2026-10-10', amount: brl('12500') },
        { number: 2, dueOn: '2026-11-09', amount: brl('12500') },
      ],
      ...commercial(),
    }
    expect(procurementOrderApproved.payload.safeParse(approved).success).toBe(true)
    expect(
      procurementOrderApproved.payload.safeParse({ ...approved, installments: [] }).success,
    ).toBe(false)
  })

  it('cancels an order and says whether anything had been committed', () => {
    expect(
      procurementOrderCancelled.payload.safeParse({
        orderId: randomUUID(),
        orderVersion: 3,
        reason: 'The supplier cannot deliver in time',
        wasApproved: true,
      }).success,
    ).toBe(true)
  })

  it('accepts a requisition-less order, because not every purchase starts as a request', () => {
    const placed = {
      orderId: randomUUID(),
      orderVersion: 1,
      placedBy: 'user:buyer',
      approvalRequired: false,
      ...commercial(),
      requisitionId: null,
    }
    expect(procurementOrderPlaced.payload.safeParse(placed).success).toBe(true)
  })
})
