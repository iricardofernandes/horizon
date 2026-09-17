import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  ledgerAccountOpened,
  ledgerPeriodClosed,
  ledgerPeriodReopened,
  ledgerTransactionPosted,
  ledgerTransactionReversed,
} from './ledger'

const brl = (amount: string) => ({ amount, currency: 'BRL' })

describe('ledger event contracts', () => {
  it('opens an account of a known type with a dotted code', () => {
    const opened = {
      accountId: randomUUID(),
      code: '1.01.001',
      name: 'Caixa',
      type: 'asset',
      parentId: randomUUID(),
      postable: true,
      currency: 'BRL',
      openedAt: '2026-09-01T12:00:00.000Z',
    }
    expect(ledgerAccountOpened.payload.safeParse(opened).success).toBe(true)
    expect(ledgerAccountOpened.payload.safeParse({ ...opened, type: 'contra' }).success).toBe(false)
    expect(ledgerAccountOpened.payload.safeParse({ ...opened, code: '1.01.x' }).success).toBe(false)
  })

  it('posts a transaction with at least two lines and a period', () => {
    const posted = {
      transactionId: randomUUID(),
      reference: 'NF-1001',
      postedOn: '2026-09-10',
      period: '2026-09',
      total: brl('10000'),
      source: { type: 'manual', id: null },
      lines: [
        {
          lineNumber: 1,
          accountId: randomUUID(),
          accountCode: '1.01.001',
          side: 'debit',
          amount: brl('10000'),
          memo: null,
        },
        {
          lineNumber: 2,
          accountId: randomUUID(),
          accountCode: '3.01.001',
          side: 'credit',
          amount: brl('10000'),
          memo: 'Venda',
        },
      ],
    }
    const complete = { ...posted, postedAt: '2026-09-10T12:00:00.000Z' }
    expect(ledgerTransactionPosted.payload.safeParse(complete).success).toBe(true)
    expect(
      ledgerTransactionPosted.payload.safeParse({ ...complete, lines: [posted.lines[0]] }).success,
    ).toBe(false)
    expect(
      ledgerTransactionPosted.payload.safeParse({ ...complete, period: '2026-13' }).success,
    ).toBe(false)
  })

  it('reverses a transaction, and closes and reopens a month', () => {
    expect(
      ledgerTransactionReversed.payload.safeParse({
        transactionId: randomUUID(),
        reversalId: randomUUID(),
        reversedAt: '2026-09-11T12:00:00.000Z',
        reason: 'Posted to the wrong account',
      }).success,
    ).toBe(true)
    const periodId = randomUUID()
    expect(
      ledgerPeriodClosed.payload.safeParse({
        periodId,
        period: '2026-09',
        closedAt: '2026-10-01T12:00:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      ledgerPeriodReopened.payload.safeParse({
        periodId,
        period: '2026-09',
        reopenedAt: '2026-10-02T12:00:00.000Z',
        reason: 'A late invoice belongs to September',
      }).success,
    ).toBe(true)
  })
})
