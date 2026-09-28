import { describe, expect, it } from 'vitest'
import {
  amountColumn,
  cutoffOf,
  downloadable,
  downloadPathOf,
  type ExportJob,
  flattenRow,
  reportingAbilitiesOf,
  reportQuery,
  tablesOf,
} from './reports'

describe('report figures as tables', () => {
  it('make each list of records a table, named by its path', () => {
    const tables = tablesOf({
      receivables: [{ currency: 'BRL', outstanding: '150000' }],
      payables: [],
      accounts: [
        { accountId: 'a', currency: 'BRL', balance: '123400' },
        { accountId: 'b', currency: 'BRL', balance: '73036' },
      ],
    })
    expect(tables.map((table) => [table.key, table.columns, table.rows.length])).toEqual([
      ['receivables', ['currency', 'outstanding'], 1],
      ['accounts', ['accountId', 'currency', 'balance'], 2],
    ])
  })

  it('spread nested figures as columns and keep loose values as one row', () => {
    const tables = tablesOf({
      month: '2026-09',
      won: [{ currency: 'BRL', won: { count: 1, value: '123400' } }],
    })
    expect(tables).toEqual([
      { key: '', columns: ['month'], rows: [{ month: '2026-09' }] },
      {
        key: 'won',
        columns: ['currency', 'won.count', 'won.value'],
        rows: [{ currency: 'BRL', 'won.count': '1', 'won.value': '123400' }],
      },
    ])
  })

  it('show nothing for nothing, and count a list inside a row', () => {
    expect(tablesOf(null)).toEqual([])
    expect(tablesOf([])).toEqual([])
    expect(flattenRow({ lines: [1, 2, 3], memo: null })).toEqual({ lines: '3', memo: '' })
  })
})

describe('export files', () => {
  const job = (status: ExportJob['status'], expiresAt: string | null): ExportJob => ({
    jobId: '01a0e4a1-67b8-74a7-ba7f-0521cba7c325',
    report: 'order-to-cash',
    cutoff: '2026-09-27T00:00:00.000Z',
    format: 'csv',
    locale: 'pt-BR',
    scheduleId: null,
    status,
    settled: true,
    rows: 1,
    bytes: 389,
    sha256: 'ab',
    failure: null,
    requestedAt: '2026-09-27T20:49:38.227Z',
    finishedAt: '2026-09-27T20:49:38.303Z',
    expiresAt,
  })
  const now = new Date('2026-09-28T12:00:00.000Z')

  it('can be fetched while ready and not expired', () => {
    expect(downloadable(job('ready', '2026-09-30T20:49:38.303Z'), now)).toBe(true)
    expect(downloadable(job('ready', '2026-09-27T20:49:38.303Z'), now)).toBe(false)
    expect(downloadable(job('running', null), now)).toBe(false)
  })

  it('are read through the web route, and only from a signed Reporting link', () => {
    expect(
      downloadPathOf(
        '/reporting/exports/01a0e4a1-67b8-74a7-ba7f-0521cba7c325/file?tenant=t&expires=1&signature=s',
      ),
    ).toBe(
      '/api/horizon/reporting/exports/01a0e4a1-67b8-74a7-ba7f-0521cba7c325/file?tenant=t&expires=1&signature=s',
    )
    expect(downloadPathOf('https://evil.example/file?x')).toBeNull()
    expect(downloadPathOf('/identity/users?x')).toBeNull()
  })
})

describe('asking a report', () => {
  it('sends the cutoff as an instant and leaves empty filters out', () => {
    expect(cutoffOf('')).toBeNull()
    expect(cutoffOf('not a date')).toBeNull()
    expect(cutoffOf('2026-09-28T12:00:00.000Z')).toBe('2026-09-28T12:00:00.000Z')
    expect(reportQuery('2026-09-28T12:00:00.000Z', { currency: ' BRL ', from: '', to: null })).toBe(
      'cutoff=2026-09-28T12%3A00%3A00.000Z&currency=BRL',
    )
    expect(reportQuery(null, {})).toBe('')
  })
})

describe('reporting abilities', () => {
  it('follow the static role map', () => {
    expect(reportingAbilitiesOf([{ module: 'reporting', role: 'viewer' }])).toEqual({
      read: true,
      reconcile: false,
      export: true,
      schedule: false,
    })
    expect(reportingAbilitiesOf([{ module: 'reporting', role: 'analyst' }]).schedule).toBe(true)
    expect(reportingAbilitiesOf([{ module: 'sales', role: 'admin' }]).read).toBe(false)
  })
})

describe('amount columns', () => {
  it('are the figures that carry money, never counts or ids', () => {
    expect(['confirmed.total', 'balance', 'won.value', 'outstanding'].map(amountColumn)).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(['confirmed.count', 'accountId', 'currency', 'month'].map(amountColumn)).toEqual([
      false,
      false,
      false,
      false,
    ])
  })
})
