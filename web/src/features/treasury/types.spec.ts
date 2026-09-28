import { describe, expect, it } from 'vitest'
import {
  awaitingApproval,
  isNegative,
  reversible,
  type StatementLine,
  shiftDays,
  type TransferRow,
} from './types'

const line = (overrides: Partial<StatementLine>): StatementLine => ({
  id: 'e',
  direction: 'outflow',
  amount: '100',
  valueOn: '2026-09-10',
  source: 'manual',
  transferId: null,
  reverses: null,
  reversedBy: null,
  counterparty: null,
  memo: null,
  reason: null,
  recordedAt: '2026-09-10T12:00:00Z',
  runningBalance: '900',
  ...overrides,
})

describe('treasury presentation helpers', () => {
  it('offers reversal only for manual entries still in force', () => {
    expect(reversible(line({}))).toBe(true)
    expect(reversible(line({ reversedBy: 'x' }))).toBe(false)
    expect(reversible(line({ source: 'transfer' }))).toBe(false)
    expect(reversible(line({ source: 'reversal' }))).toBe(false)
  })

  it('reads signed balances and shifts calendar dates across months', () => {
    expect(isNegative('-5')).toBe(true)
    expect(isNegative('5')).toBe(false)
    expect(shiftDays('2026-10-01', -30)).toBe('2026-09-01')
  })
})

describe('the approval queue', () => {
  const transfer = (
    id: string,
    status: TransferRow['status'],
    requestedAt: string,
  ): TransferRow => ({
    id,
    fromAccountId: 'a',
    fromAccountName: 'Main',
    toAccountId: 'b',
    toAccountName: 'Reserve',
    amount: '200000',
    fee: null,
    currency: 'BRL',
    valueOn: '2026-09-28',
    memo: null,
    status,
    requestedBy: 'user-1',
    requestedAt,
    postedAt: null,
    decidedBy: null,
    decidedFor: null,
    cancellationReason: null,
  })

  it('holds only pending transfers, oldest first', () => {
    const queue = awaitingApproval([
      transfer('late', 'pending', '2026-09-28T12:00:00Z'),
      transfer('done', 'posted', '2026-09-28T09:00:00Z'),
      transfer('early', 'pending', '2026-09-28T10:00:00Z'),
      transfer('refused', 'rejected', '2026-09-28T08:00:00Z'),
    ])
    expect(queue.map((entry) => entry.id)).toEqual(['early', 'late'])
  })
})
