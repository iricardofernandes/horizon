import { describe, expect, it } from 'vitest'
import {
  decimalOf,
  displayStatus,
  inView,
  localToday,
  scheduleOf,
  type TitleRow,
  viewsOf,
} from './types'

const row = (overrides: Partial<TitleRow>): TitleRow => ({
  id: 'r',
  documentNumber: 'NF-1',
  partyId: 'p',
  partyName: 'Acme',
  origin: { type: 'manual' },
  currency: 'BRL',
  issuedOn: '2026-09-01',
  nextDueOn: '2026-09-10',
  status: 'posted',
  settlementState: 'open',
  approvalState: 'none',
  overdue: false,
  total: '100',
  outstanding: '100',
  ...overrides,
})

describe('receivable presentation helpers', () => {
  it('splits a term without losing a minor unit, as Financial does', () => {
    const schedule = scheduleOf(1000n, '2026-09-01', {
      installments: [
        { dueInDays: 30, basisPoints: 3333 },
        { dueInDays: 60, basisPoints: 3333 },
        { dueInDays: 90, basisPoints: 3334 },
      ],
    })
    expect(schedule).toEqual([
      { dueOn: '2026-10-01', amount: '333' },
      { dueOn: '2026-10-31', amount: '333' },
      { dueOn: '2026-11-30', amount: '334' },
    ])
  })

  it('partitions rows into the same views the API serves', () => {
    const overdue = row({ overdue: true, settlementState: 'partially-settled' })
    expect(inView(overdue, 'overdue')).toBe(true)
    expect(inView(overdue, 'open')).toBe(true)
    expect(inView(row({ settlementState: 'settled' }), 'open')).toBe(false)
    expect(inView(row({ status: 'reversed' }), 'closed')).toBe(true)
    expect(displayStatus(overdue)).toBe('overdue')
    expect(displayStatus(row({ status: 'draft' }))).toBe('draft')
    const pending = row({ status: 'draft', approvalState: 'pending' })
    expect(displayStatus(pending)).toBe('awaiting-approval')
    expect(inView(pending, 'awaiting-approval')).toBe(true)
    expect(viewsOf('receivable')).not.toContain('awaiting-approval')
    expect(viewsOf('payable')).toContain('awaiting-approval')
  })

  it('formats minor units and the local calendar date', () => {
    expect(decimalOf('5')).toBe('0.05')
    expect(decimalOf('123456')).toBe('1234.56')
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05')
  })
})
