import { describe, expect, it } from 'vitest'
import {
  claimsOf,
  type Fetcher,
  federatedJobs,
  federatedSearch,
  readable,
  SEARCH_SOURCES,
} from './federation'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Answers per module path prefix; a function stands for a slow or failing module. */
function fetcherOf(answers: Record<string, (signal: AbortSignal) => Promise<Response>>): {
  fetcher: Fetcher
  asked: string[]
} {
  const asked: string[] = []
  return {
    asked,
    fetcher: (path, signal) => {
      asked.push(path)
      const key = Object.keys(answers).find((prefix) => path.startsWith(prefix))
      return key
        ? (answers[key]?.(signal) ?? Promise.reject(new Error('none')))
        : Promise.resolve(json({ data: [] }))
    },
  }
}

const hang = (signal: AbortSignal) =>
  new Promise<Response>((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error('aborted'))),
  )

describe('federated search', () => {
  it('asks only the modules the roles can read', async () => {
    const { fetcher, asked } = fetcherOf({})
    const roles = [
      { module: 'catalog', role: 'viewer' },
      { module: 'parties', role: 'fiscal-reader' },
    ]
    expect(readable(SEARCH_SOURCES, roles).map((source) => source.id)).toEqual(['catalog.items'])
    const answer = await federatedSearch(fetcher, roles, 'café')
    expect(asked).toEqual(['/catalog/items?search=caf%C3%A9&limit=5'])
    expect(answer.sources).toEqual([{ source: 'catalog.items', module: 'catalog', status: 'ok' }])
  })

  it('answers with what came back and names the module that did not', async () => {
    const { fetcher } = fetcherOf({
      '/catalog/': async () => json({ data: [{ id: 'i-1', name: 'Café', sku: 'CAF-1' }] }),
      '/crm/': hang,
      '/parties/': async () => json({ message: 'down' }, 503),
      '/financial/receivables': async () => json({ message: 'no' }, 403),
    })
    const roles = ['catalog', 'crm', 'parties', 'financial'].map((module) => ({
      module,
      role: 'admin',
    }))
    const answer = await federatedSearch(fetcher, roles, 'caf', 50)
    expect(answer.results).toEqual([
      {
        source: 'catalog.items',
        module: 'catalog',
        id: 'i-1',
        title: 'Café',
        subtitle: 'CAF-1',
        href: '/app/catalog/items',
      },
    ])
    expect(
      Object.fromEntries(answer.sources.map((source) => [source.source, source.status])),
    ).toEqual({
      'parties.parties': 'error',
      'catalog.items': 'ok',
      'crm.accounts': 'timeout',
      'financial.receivables': 'forbidden',
      'financial.payables': 'ok',
    })
  })

  it('asks nothing for a term too short', async () => {
    const { fetcher, asked } = fetcherOf({})
    expect(await federatedSearch(fetcher, [{ module: 'catalog', role: 'admin' }], ' a ')).toEqual({
      results: [],
      sources: [],
    })
    expect(asked).toEqual([])
  })
})

describe('the job centre', () => {
  it('keeps the reader own jobs across modules, newest first', async () => {
    const { fetcher } = fetcherOf({
      '/parties/imports': async () =>
        json({
          data: [
            {
              id: 'j-1',
              kind: 'parties',
              status: 'running',
              requestedBy: 'me',
              createdAt: '2026-09-28T10:00:00Z',
              progress: { total: 10, remaining: 4 },
            },
            {
              id: 'j-2',
              kind: 'parties',
              status: 'completed',
              requestedBy: 'someone',
              createdAt: '2026-09-28T11:00:00Z',
              progress: { total: 1, remaining: 0 },
            },
          ],
        }),
      '/sales/billing-runs': async () =>
        json([
          {
            id: 'r-1',
            competence: '2026-09',
            status: 'completed',
            requestedBy: 'me',
            startedAt: '2026-09-28T12:00:00Z',
            totals: { billed: 2, skipped: 1, pending: 0 },
          },
        ]),
      '/reporting/': hang,
    })
    const roles = [
      { module: 'parties', role: 'admin' },
      { module: 'sales', role: 'viewer' },
      { module: 'reporting', role: 'viewer' },
      { module: 'catalog', role: 'viewer' },
    ]
    const answer = await federatedJobs(fetcher, roles, 'me', 50)
    expect(answer.jobs.map((job) => [job.id, job.done, job.total])).toEqual([
      ['r-1', 3, 3],
      ['j-1', 6, 10],
    ])
    expect(answer.sources.map((source) => `${source.source}:${source.status}`)).toEqual([
      'parties.imports:ok',
      'reporting.exports:timeout',
      'sales.billing-runs:ok',
    ])
  })
})

describe('claims', () => {
  it('reads the subject and roles, and nothing from a broken token', () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: 'u-1', roles: [{ module: 'crm', role: 'viewer' }, { bad: 1 }] }),
    ).toString('base64url')
    expect(claimsOf(`h.${payload}.s`)).toEqual({
      subject: 'u-1',
      roles: [{ module: 'crm', role: 'viewer' }],
    })
    expect(claimsOf('garbage')).toEqual({ subject: null, roles: [] })
    expect(claimsOf(null)).toEqual({ subject: null, roles: [] })
  })
})
