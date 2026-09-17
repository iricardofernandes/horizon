import { describe, expect, it } from 'vitest'
import { isNegative, reversible, type StatementLine, shiftDays } from './types'

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
