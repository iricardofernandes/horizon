import { describe, expect, it } from 'vitest'
import {
  AUDIT_SOURCES,
  auditCsvRow,
  auditFilterOf,
  auditPath,
  auditSourcesFor,
  chosenSources,
  collectAudit,
  federatedAudit,
  pageOf,
} from './audit'

const entry = (sequence: number, occurredAt: string, actor = 'user-1') => ({
  sequence,
  occurredAt,
  actor,
  action: 'payable.approved',
  subjectType: 'title',
  subjectId: 'title-1',
  requestId: null,
  traceId: null,
  details: { onBehalfOf: 'user-2' },
  hash: 'a'.repeat(64),
})

const page = (
  data: unknown[],
  chain: { status: string; broken?: number[] } = { status: 'intact' },
  nextCursor?: string,
) => ({
  data,
  page: nextCursor ? { nextCursor, hasMore: true } : { hasMore: false },
  chain: { checked: data.length, broken: [], ...chain },
})

const respond = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))

describe('who reads which audit log', () => {
  it('asks each module only of its admins, and Identity, Files and Agent of workspace owners', () => {
    expect(auditSourcesFor([{ module: 'financial', role: 'admin' }]).map((s) => s.module)).toEqual([
      'financial',
    ])
    expect(auditSourcesFor([{ module: 'financial', role: 'operator' }])).toEqual([])
    expect(auditSourcesFor([{ module: 'identity', role: 'owner' }]).map((s) => s.module)).toEqual([
      'identity',
      'files',
      'agent',
    ])
    expect(AUDIT_SOURCES.map((source) => source.module)).not.toContain('parties')
    // An auditor reads the logs and nothing else (Phase 69).
    expect(
      auditSourcesFor([
        { module: 'ledger', role: 'auditor' },
        { module: 'identity', role: 'auditor' },
      ]).map((source) => source.module),
    ).toEqual(['identity', 'ledger', 'files', 'agent'])
  })

  it('narrows to the modules asked for', () => {
    const search = new URLSearchParams('module=ledger,treasury')
    expect(chosenSources(AUDIT_SOURCES, search).map((source) => source.module)).toEqual([
      'treasury',
      'ledger',
    ])
    expect(chosenSources(AUDIT_SOURCES, new URLSearchParams())).toHaveLength(13)
  })
})

describe('the audit filter', () => {
  it('keeps bounded text and valid instants only', () => {
    const filter = auditFilterOf(
      new URLSearchParams(`actor=${'x'.repeat(300)}&from=2026-09-01&to=nonsense&action= `),
    )
    expect(filter.actor).toHaveLength(200)
    expect(filter.from).toBe('2026-09-01T00:00:00.000Z')
    expect(filter).not.toHaveProperty('to')
    expect(filter).not.toHaveProperty('action')
  })

  it('builds the module path with the cursor', () => {
    const source = AUDIT_SOURCES.find((candidate) => candidate.module === 'ledger')
    if (!source) throw new Error('ledger missing')
    expect(auditPath(source, { action: 'manual-entry.approved' }, '41')).toBe(
      '/ledger/audit?action=manual-entry.approved&limit=50&cursor=41',
    )
  })
})

describe('the federated audit search', () => {
  it('merges pages newest first, carries each chain verdict, and names the silent', async () => {
    const sources = AUDIT_SOURCES.filter((source) =>
      ['financial', 'ledger', 'treasury'].includes(source.module),
    )
    const answer = await federatedAudit(
      (path) => {
        if (path.startsWith('/financial'))
          return respond(page([entry(2, '2026-09-28T10:00:00.000Z')], { status: 'intact' }, '2'))
        if (path.startsWith('/ledger'))
          return respond(
            page([entry(7, '2026-09-28T11:00:00.000Z')], { status: 'broken', broken: [7] }),
          )
        return respond({ message: 'down' }, 503)
      },
      sources,
      {},
    )
    expect(answer.entries.map((row) => `${row.module}:${row.sequence}`)).toEqual([
      'ledger:7',
      'financial:2',
    ])
    expect(answer.sources).toEqual([
      {
        module: 'financial',
        status: 'ok',
        chain: { status: 'intact', checked: 1, broken: [] },
        nextCursor: '2',
      },
      { module: 'treasury', status: 'error', chain: null, nextCursor: null },
      {
        module: 'ledger',
        status: 'ok',
        chain: { status: 'broken', checked: 1, broken: [7] },
        nextCursor: null,
      },
    ])
  })

  it('continues only the modules that have more', async () => {
    const asked: string[] = []
    const sources = AUDIT_SOURCES.filter((source) =>
      ['financial', 'ledger'].includes(source.module),
    )
    await federatedAudit(
      (path) => {
        asked.push(path)
        return respond(page([]))
      },
      sources,
      {},
      { financial: '2', ledger: null },
    )
    expect(asked).toEqual(['/financial/audit?limit=50&cursor=2'])
  })

  it('refuses an answer that is not an audit page', () => {
    expect(pageOf('sales', { data: [] })).toBeNull()
    expect(pageOf('sales', { data: [], chain: { status: 'maybe' } })).toBeNull()
  })

  it('collects every page for an export, and stops at the limit', async () => {
    const source = AUDIT_SOURCES.find((candidate) => candidate.module === 'financial')
    if (!source) throw new Error('financial missing')
    const collected = await collectAudit(
      (path) =>
        respond(
          path.includes('cursor=')
            ? page([entry(1, '2026-09-27T10:00:00.000Z')], { status: 'broken', broken: [1] })
            : page(
                [entry(3, '2026-09-28T10:00:00.000Z'), entry(2, '2026-09-28T09:00:00.000Z')],
                {
                  status: 'intact',
                },
                '2',
              ),
        ),
      source,
      {},
      10,
    )
    expect(collected).toMatchObject({ status: 'ok', broken: [1], truncated: false })
    expect(collected.entries.map((row) => row.sequence)).toEqual([3, 2, 1])
    const capped = await collectAudit(
      () => respond(page([entry(3, 'a'), entry(2, 'b')], { status: 'intact' }, '2')),
      source,
      {},
      1,
    )
    expect(capped).toMatchObject({ truncated: true })
    expect(capped.entries).toHaveLength(1)
  })

  it('writes a row per entry, naming the actor and hiding a sealed diff', () => {
    const [row] =
      pageOf('identity', page([{ ...entry(1, 'x'), details: null, sealed: true }]))?.entries ?? []
    if (!row) throw new Error('no row')
    expect(auditCsvRow(row, { 'user-1': 'Ana' })).toMatchObject({
      module: 'identity',
      actor_name: 'Ana',
      details: '[sealed]',
    })
  })
})
