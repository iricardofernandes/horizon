import { describe, expect, it } from 'vitest'
import {
  amountOf,
  currencyDigits,
  fileNameOf,
  isCadence,
  isFormat,
  neutralize,
  nextDue,
  startOfLocalDay,
  timeZoneOf,
} from './exports'

describe('cells a spreadsheet will not run', () => {
  it('keeps text that could start a formula as text', () => {
    for (const text of ['=SUM(A1)', '+1', '-2+3', '@cmd', '\tx', '\rx'])
      expect(neutralize(text)).toBe(`'${text}`)
    expect(neutralize('Acme')).toBe('Acme')
    expect(neutralize('a=b')).toBe('a=b')
  })
})

describe('amounts', () => {
  it('turns minor units into the currency amount, by its own digits', () => {
    expect(currencyDigits('BRL')).toBe(2)
    expect(currencyDigits('JPY')).toBe(0)
    expect(currencyDigits('KWD')).toBe(3)
    expect(currencyDigits('XXZ')).toBe(2)
    expect(amountOf('123450', 'BRL')).toBe(1234.5)
    expect(amountOf('-150', 'BRL')).toBe(-1.5)
    expect(amountOf('500', 'JPY')).toBe(500)
    expect(amountOf('1234', 'KWD')).toBe(1.234)
  })
})

describe('due instants', () => {
  it('is local midnight every day, on Mondays, or on the 1st', () => {
    const after = new Date('2026-09-27T12:00:00Z') // a Sunday
    expect(nextDue('daily', 'America/Sao_Paulo', after).toISOString()).toBe(
      '2026-09-28T03:00:00.000Z',
    )
    expect(nextDue('weekly', 'America/Sao_Paulo', after).toISOString()).toBe(
      '2026-09-28T03:00:00.000Z',
    )
    expect(nextDue('monthly', 'America/Sao_Paulo', after).toISOString()).toBe(
      '2026-10-01T03:00:00.000Z',
    )
    expect(nextDue('daily', 'UTC', after).toISOString()).toBe('2026-09-28T00:00:00.000Z')
    expect(nextDue('weekly', 'UTC', new Date('2026-09-28T00:00:00Z')).toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    )
  })

  it('is strictly after the instant given, so a due instant leads to the next one', () => {
    const due = nextDue('daily', 'Europe/Berlin', new Date('2026-09-27T12:00:00Z'))
    expect(due.toISOString()).toBe('2026-09-27T22:00:00.000Z')
    expect(nextDue('daily', 'Europe/Berlin', due).toISOString()).toBe('2026-09-28T22:00:00.000Z')
  })

  it('follows daylight saving across its change', () => {
    // New York leaves daylight saving on 2026-11-01.
    expect(
      startOfLocalDay({ year: 2026, month: 11, day: 1 }, 'America/New_York').toISOString(),
    ).toBe('2026-11-01T04:00:00.000Z')
    expect(
      startOfLocalDay({ year: 2026, month: 11, day: 2 }, 'America/New_York').toISOString(),
    ).toBe('2026-11-02T05:00:00.000Z')
  })

  it('knows its values', () => {
    expect(isCadence('weekly')).toBe(true)
    expect(isCadence('hourly')).toBe(false)
    expect(isFormat('xlsx')).toBe(true)
    expect(isFormat('pdf')).toBe(false)
    expect(timeZoneOf('America/Sao_Paulo').isRight()).toBe(true)
    expect(timeZoneOf('Mars/Olympus').isLeft()).toBe(true)
    expect(fileNameOf('cash-position', new Date('2026-09-27T20:19:26.792Z'), 'csv')).toBe(
      'cash-position-20260927-2019Z.csv',
    )
  })
})
