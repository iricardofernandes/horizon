import { describe, expect, it } from 'vitest'
import {
  checkResultOf,
  cutoffOf,
  differencesOf,
  isReportName,
  REPORT_NAMES,
  REPORTS,
  reportFilterOf,
  runOutcomeOf,
} from './reports'

describe('the report catalogue', () => {
  it('names the sources of every report, and checks only against one of them', () => {
    for (const name of REPORT_NAMES) {
      const report = REPORTS[name]
      expect(report.name).toBe(name)
      for (const check of report.checks) expect(report.sources).toContain(check.owner)
      for (const derived of report.derived) expect(report.sources).toContain(derived.from)
    }
    expect(isReportName('cash-position')).toBe(true)
    expect(isReportName('stock-vs-ledger')).toBe(false)
  })

  it('knows which owner answers as of the cutoff itself', () => {
    const won = REPORTS['pipeline-to-revenue'].checks[0]
    expect(won).toMatchObject({ name: 'won-by-month', asOfCutoff: true })
    expect(REPORTS['cash-position'].checks.every((check) => !check.asOfCutoff)).toBe(true)
  })
})

describe('comparing figures', () => {
  it('finds each key where they disagree, a missing key counting as zero', () => {
    expect(differencesOf({ BRL: '100', USD: '0' }, { BRL: '100' })).toEqual([])
    expect(differencesOf({ BRL: '100' }, { BRL: '90', EUR: '5' })).toEqual([
      { key: 'BRL', reported: '100', owner: '90' },
      { key: 'EUR', reported: '0', owner: '5' },
    ])
    // Amounts in minor units can exceed a double's precision.
    expect(differencesOf({ BRL: '9007199254740993' }, { BRL: '9007199254740992' })).toHaveLength(1)
  })

  it('matches a run only when every check matches, and a difference outranks the rest', () => {
    const matched = checkResultOf('orders-confirmed', { 'BRL:count': '2' }, { 'BRL:count': '2' })
    const different = checkResultOf('orders-confirmed', { 'BRL:count': '2' }, {})
    const notComparable = {
      check: 'account-balances',
      outcome: 'not-comparable',
      reason: 'moved-after-cutoff',
    } as const
    expect(matched.outcome).toBe('matched')
    expect(different).toMatchObject({ outcome: 'different', differences: [{ key: 'BRL:count' }] })
    expect(runOutcomeOf([matched])).toBe('matched')
    expect(runOutcomeOf([matched, notComparable])).toBe('not-comparable')
    expect(runOutcomeOf([notComparable, different])).toBe('different')
  })
})

describe('filters and cutoffs', () => {
  it('accepts a currency and a range of months, and refuses anything else', () => {
    expect(reportFilterOf({ currency: 'BRL', from: '2026-01', to: '2026-09' }).value).toEqual({
      currency: 'BRL',
      from: '2026-01',
      to: '2026-09',
    })
    expect(reportFilterOf({}).value).toEqual({ currency: null, from: null, to: null })
    expect(reportFilterOf({ currency: 'brl' }).isLeft()).toBe(true)
    expect(reportFilterOf({ from: '2026-13' }).isLeft()).toBe(true)
    expect(reportFilterOf({ to: '2026-9' }).isLeft()).toBe(true)
    expect(reportFilterOf({ from: '2026-09', to: '2026-01' }).isLeft()).toBe(true)
  })

  it('takes now for a missing cutoff and refuses one in the future', () => {
    const now = new Date('2026-09-27T12:00:00Z')
    expect(cutoffOf(null, now).value).toEqual(now)
    expect(cutoffOf(new Date('2026-09-27T11:00:00Z'), now).isRight()).toBe(true)
    expect(cutoffOf(new Date('2026-09-27T12:00:01Z'), now).isLeft()).toBe(true)
    expect(cutoffOf(new Date('nope'), now).isLeft()).toBe(true)
  })
})
