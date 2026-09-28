import { describe, expect, it } from 'vitest'
import { settledCutoff } from '@/infrastructure/controls/scheduled-controls-worker'
import {
  AUDITED_MODULES,
  type ConsistencyRun,
  ConsistencyStore,
  RunConsistencyChecksUseCase,
} from './consistency'
import { type OwnerAnswer, OwnerReports } from './ports/report-store'

const RECEIVABLES = 'account-receivables'
const CASH = 'account-cash'

class Owners extends OwnerReports {
  readonly asked: string[] = []
  constructor(private readonly answers: Record<string, unknown>) {
    super()
  }
  async read(
    path: string,
    _query: Readonly<Record<string, string>>,
    bearer: string,
  ): Promise<OwnerAnswer> {
    this.asked.push(`${path} as ${bearer}`)
    const module = path.split('/')[1] ?? ''
    if (path.endsWith('/audit'))
      return module === 'files' && this.answers.filesDown
        ? { status: 'unavailable' }
        : {
            status: 'ok',
            body: {
              data: [{}, {}],
              page: { hasMore: false },
              chain: {
                status: 'intact',
                checked: 2,
                broken: module === this.answers.broken ? [2] : [],
              },
            },
          }
    return path in this.answers
      ? { status: 'ok', body: this.answers[path] }
      : { status: 'forbidden' }
  }
}

class Store extends ConsistencyStore {
  readonly runs: ConsistencyRun[] = []
  async record(_tenant: string, run: ConsistencyRun) {
    this.runs.push(run)
  }
  async list() {
    return this.runs
  }
}

function owners(overrides: Record<string, unknown> = {}) {
  return new Owners({
    '/ledger/mappings': {
      data: [
        { role: 'receivables', accountId: RECEIVABLES },
        { role: 'cash', accountId: CASH },
        { role: 'cash', accountId: CASH },
      ],
    },
    '/ledger/accounts': {
      data: [
        { id: RECEIVABLES, currency: 'BRL', balance: '150000' },
        { id: CASH, currency: 'BRL', balance: '90000' },
        { id: 'unmapped', currency: 'BRL', balance: '7' },
      ],
    },
    '/ledger/postings/pending': { data: [], total: 0 },
    '/financial/receivables/summary': { currencies: [{ currency: 'BRL', outstanding: '150000' }] },
    '/financial/payables/summary': { currencies: [] },
    '/treasury/accounts': {
      data: [
        { currency: 'BRL', bookBalance: '60000' },
        { currency: 'BRL', bookBalance: '30000' },
      ],
    },
    '/inventory/stock-valuation': { totals: [{ currency: 'BRL', value: '42000' }] },
    ...overrides,
  })
}

const run = (reports: OwnerReports) => {
  const store = new Store()
  const clock = { now: () => new Date('2026-09-28T02:00:00.000Z') }
  return new RunConsistencyChecksUseCase(reports, store, clock)
    .execute({
      tenantId: 't',
      actor: 'service:reporting',
      requestId: null,
      trigger: 'scheduled',
      bearer: 'svc',
    })
    .then((result) => ({ result, store }))
}

describe('running the consistency checks', () => {
  it('matches owners with their ledger accounts, and keeps the run', async () => {
    const reports = owners()
    const { result, store } = await run(reports)
    expect(result.outcome).toBe('consistent')
    expect(Object.fromEntries(result.checks.map((check) => [check.check, check.outcome]))).toEqual({
      'receivables-control': 'matched',
      'payables-control': 'not-applicable',
      'cash-accounts': 'matched',
      'inventory-accounts': 'not-applicable',
      'audit-chains': 'matched',
    })
    expect(result.checks.at(-1)?.compared).toBe(AUDITED_MODULES.length)
    expect(store.runs).toEqual([result])
    expect(reports.asked.every((entry) => entry.endsWith('as svc'))).toBe(true)
  })

  it('catches a broken balance and a broken chain', async () => {
    const { result } = await run(
      owners({
        '/ledger/accounts': {
          data: [
            { id: RECEIVABLES, currency: 'BRL', balance: '170000' },
            { id: CASH, currency: 'BRL', balance: '90000' },
          ],
        },
        broken: 'treasury',
      }),
    )
    expect(result.outcome).toBe('inconsistent')
    expect(
      result.checks.find((check) => check.check === 'receivables-control')?.differences,
    ).toEqual([{ key: 'BRL', owner: '150000', ledger: '170000' }])
    expect(result.checks.find((check) => check.check === 'audit-chains')?.reason).toBe(
      'broken: treasury at 2',
    )
  })

  it('is incomplete when an owner cannot be read', async () => {
    const reports = owners({ filesDown: true })
    delete (reports as unknown as { answers: Record<string, unknown> }).answers[
      '/treasury/accounts'
    ]
    const { result } = await run(reports)
    expect(result.outcome).toBe('incomplete')
    expect(result.checks.find((check) => check.check === 'cash-accounts')).toMatchObject({
      outcome: 'unread',
      reason: '/treasury/accounts: forbidden',
    })
  })
})

describe('the settled cutoff of a report', () => {
  it('is the earliest watermark of its sources, or none while one is missing', () => {
    const early = new Date('2026-09-28T01:00:00.000Z')
    const late = new Date('2026-09-28T01:30:00.000Z')
    const marks = new Map<string, Date | null>([
      ['financial', late],
      ['treasury', early],
      ['sales', null],
    ])
    expect(settledCutoff(marks, ['financial', 'treasury'])).toEqual(early)
    expect(settledCutoff(marks, ['financial', 'sales'])).toBeNull()
  })
})
