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

describe('sales contract event contracts', () => {
  const contract = { contractId: randomUUID(), customerId: randomUUID() }
  it('activates, amends, suspends and cancels with dates and revisions', async () => {
    const {
      salesContractActivated,
      salesContractAmended,
      salesContractCancelled,
      salesContractSuspended,
    } = await import('./sales')
    expect(
      salesContractActivated.payload.safeParse({
        ...contract,
        revision: 1,
        recurrence: 'monthly',
        startsOn: '2026-10-01',
        endsOn: '2027-09-30',
        billingDay: 5,
        autoRenew: true,
      }).success,
    ).toBe(true)
    expect(
      salesContractAmended.payload.safeParse({
        ...contract,
        revision: 2,
        kind: 'renewal',
        effectiveFrom: '2027-10-01',
        recurrence: 'monthly',
        endsOn: '2028-09-30',
        readjustmentBasisPoints: 450,
      }).success,
    ).toBe(true)
    expect(
      salesContractSuspended.payload.safeParse({
        ...contract,
        suspensionId: randomUUID(),
        from: '2026-12-01',
        until: null,
        reason: 'Férias coletivas do cliente',
      }).success,
    ).toBe(true)
    expect(
      salesContractCancelled.payload.safeParse({
        ...contract,
        effectiveFrom: '2027-01-01',
        reason: '',
      }).success,
    ).toBe(false)
  })
})

describe('sales contract period event contracts', () => {
  const period = {
    contractId: randomUUID(),
    billedPeriodId: randomUUID(),
    customerId: randomUUID(),
    competence: '2026-10',
  }

  it('bills a period once with its frozen lines, installments and run', async () => {
    const { salesContractPeriodBilled } = await import('./sales')
    const billed = {
      ...period,
      revision: 2,
      startsOn: '2026-10-01',
      endsOn: '2026-10-31',
      issuedOn: '2026-10-05',
      lines: delivered.lines,
      value: brl('142500'),
      installments: [{ number: 1, dueOn: '2026-10-20', amount: brl('142500') }],
      runId: null,
      billedBy: 'user:operator',
    }
    expect(salesContractPeriodBilled.payload.safeParse(billed).success).toBe(true)
    expect(
      salesContractPeriodBilled.payload.safeParse({ ...billed, runId: randomUUID() }).success,
    ).toBe(true)
    expect(salesContractPeriodBilled.payload.safeParse({ ...billed, lines: [] }).success).toBe(
      false,
    )
    expect(
      salesContractPeriodBilled.payload.safeParse({ ...billed, competence: '2026-10-01' }).success,
    ).toBe(false)
  })

  it('credits a billed period with a reason code, and names the receivable origin', async () => {
    const { salesContractPeriodCredited } = await import('./sales')
    const credited = {
      ...period,
      entryIds: [randomUUID()],
      reasonCode: 'not-provided',
      reason: 'O posto ficou fechado no mês',
      creditedOn: '2026-10-20',
    }
    expect(salesContractPeriodCredited.payload.safeParse(credited).success).toBe(true)
    expect(
      salesContractPeriodCredited.payload.safeParse({ ...credited, reasonCode: 'other' }).success,
    ).toBe(false)
    const origin = { type: 'sales-contract-period', documentId: period.billedPeriodId }
    expect(financialReceivablePosted.payload.shape.origin.safeParse(origin).success).toBe(true)
  })
})
