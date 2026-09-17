import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  financialPayablePosted,
  financialPayableReversed,
  financialReceivablePosted,
  financialReceivableReversed,
  financialSettlementRecorded,
  financialSettlementReversed,
} from './financial'

const brl = (amount: string) => ({ amount, currency: 'BRL' })

const posted = {
  titleId: randomUUID(),
  partyId: randomUUID(),
  documentNumber: 'NF-1001',
  origin: { type: 'sales-order', orderId: randomUUID() },
  categoryId: randomUUID(),
  issuedOn: '2026-09-16',
  competenceOn: '2026-09-01',
  total: brl('10000'),
  installments: [
    { number: 1, dueOn: '2026-10-16', amount: brl('5000') },
    { number: 2, dueOn: '2026-11-15', amount: brl('5000') },
  ],
  allocations: [],
  postedAt: '2026-09-16T12:00:00.000Z',
}

describe('financial event contracts', () => {
  it('posts a receivable with its schedule and origin', () => {
    expect(financialReceivablePosted.payload.safeParse(posted).success).toBe(true)
    expect(
      financialReceivablePosted.payload.safeParse({ ...posted, origin: { type: 'sales-order' } })
        .success,
    ).toBe(false)
    expect(
      financialReceivablePosted.payload.safeParse({ ...posted, issuedOn: '2026-09-16T00:00:00Z' })
        .success,
    ).toBe(false)
    expect(
      financialReceivablePosted.payload.safeParse({ ...posted, installments: [] }).success,
    ).toBe(false)
  })

  it('requires a reason to reverse', () => {
    const reversal = {
      titleId: randomUUID(),
      partyId: randomUUID(),
      reversedAt: '2026-09-16T12:00:00.000Z',
      reason: 'Issued twice',
    }
    expect(financialReceivableReversed.payload.safeParse(reversal).success).toBe(true)
    expect(
      financialReceivableReversed.payload.safeParse({ ...reversal, reason: ' ' }).success,
    ).toBe(false)
  })

  it('records and reverses a settlement with its effect on the balance', () => {
    const recorded = {
      settlementId: randomUUID(),
      titleId: randomUUID(),
      direction: 'receivable',
      partyId: randomUUID(),
      installmentNumber: 1,
      settledOn: '2026-09-20',
      received: brl('4900'),
      discount: brl('100'),
      interest: brl('0'),
      penalty: brl('0'),
      paymentMethodId: null,
      outstanding: brl('5000'),
      recordedAt: '2026-09-20T12:00:00.000Z',
    }
    expect(financialSettlementRecorded.payload.safeParse(recorded).success).toBe(true)
    expect(
      financialSettlementRecorded.payload.safeParse({
        ...recorded,
        treasuryAccountId: randomUUID(),
      }).success,
    ).toBe(true)
    expect(
      financialSettlementRecorded.payload.safeParse({ ...recorded, direction: 'refund' }).success,
    ).toBe(false)
    expect(
      financialSettlementReversed.payload.safeParse({
        settlementId: recorded.settlementId,
        titleId: recorded.titleId,
        direction: 'receivable',
        partyId: recorded.partyId,
        reversedAt: '2026-09-21T12:00:00.000Z',
        reason: 'Payment bounced',
        outstanding: brl('10000'),
      }).success,
    ).toBe(true)
  })

  it('gives payables the same posted and reversed shape as receivables', () => {
    expect(financialPayablePosted.payload.safeParse(posted).success).toBe(true)
    expect(
      financialPayableReversed.payload.safeParse({
        titleId: randomUUID(),
        partyId: randomUUID(),
        reversedAt: '2026-09-16T12:00:00.000Z',
        reason: 'Duplicated invoice',
      }).success,
    ).toBe(true)
  })
})
