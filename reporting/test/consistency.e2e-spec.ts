import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConsistencyRun } from '@/application/consistency'
import { FreshnessGauge } from '@/infrastructure/controls/freshness-gauge'
import { RelayTenantScan } from '@/infrastructure/controls/scheduled-controls-worker'
import { ReportingDatabase } from '@/infrastructure/database/drizzle/reporting-database'

let database: ReportingDatabase
let administrator: ReturnType<typeof postgres>

beforeAll(() => {
  database = new ReportingDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end()])
})

const run = (outcome: ConsistencyRun['outcome']): ConsistencyRun => ({
  runId: randomUUID(),
  trigger: 'scheduled',
  outcome,
  checks: [
    {
      check: 'receivables-control',
      outcome: outcome === 'inconsistent' ? 'differences' : 'matched',
      compared: 1,
      differences:
        outcome === 'inconsistent' ? [{ key: 'BRL', owner: '150000', ledger: '160000' }] : [],
      reason: null,
    },
  ],
  pendingPostings: 0,
  startedBy: 'service:reporting',
  startedAt: new Date('2026-09-28T02:00:00.000Z'),
  finishedAt: new Date('2026-09-28T02:00:03.000Z'),
})

describe('consistency runs (Phase 69)', () => {
  it('are kept with their audit link, newest first, and never rewritten', async () => {
    const tenantId = randomUUID()
    const first = run('consistent')
    const second = {
      ...run('inconsistent'),
      startedAt: new Date('2026-09-29T02:00:00.000Z'),
      finishedAt: new Date('2026-09-29T02:00:02.000Z'),
    }
    await database.consistency.record(tenantId, first, null)
    await database.consistency.record(tenantId, second, 'req-1')
    const listed = await database.consistency.list(tenantId, 10)
    expect(listed.map((entry) => entry.outcome)).toEqual(['inconsistent', 'consistent'])
    expect(listed[0]?.checks[0]?.differences).toEqual([
      { key: 'BRL', owner: '150000', ledger: '160000' },
    ])
    expect(await database.consistency.list(randomUUID(), 10)).toEqual([])
    const trail = await administrator`select actor, action, subject_id, request_id from audit_log
      where tenant_id = ${tenantId} order by sequence`
    expect(trail).toEqual([
      {
        actor: 'service:reporting',
        action: 'consistency.run',
        subject_id: first.runId,
        request_id: null,
      },
      {
        actor: 'service:reporting',
        action: 'consistency.run',
        subject_id: second.runId,
        request_id: 'req-1',
      },
    ])
    await expect(administrator`update consistency_runs set outcome = 'consistent'`).rejects.toThrow(
      /append-only|history/,
    )
    const page = await database.auditPage(tenantId, { limit: 10 })
    expect(page.chain.status).toBe('intact')
  })

  it('finds tenants as the relay role, and reads nothing else of them', async () => {
    const tenantId = randomUUID()
    await administrator`insert into tenants (id) values (${tenantId})`
    const sealId = randomUUID()
    await administrator`insert into source_seals (id, tenant_id, source_module, through,
      producer_count, journal_count, outcome, sealed_at, received_at)
      values (${sealId}, ${tenantId}, 'financial', now(), 0, 0, 'matched', now(), now())`
    await administrator`insert into source_watermarks (tenant_id, source_module, through, seal_id, updated_at)
      values (${tenantId}, 'financial', now(), ${sealId}, now())`
    const url = new URL(process.env.DATABASE_URL ?? '')
    url.username = 'horizon_relay'
    url.password = 'test'
    const scan = new RelayTenantScan(url.toString())
    try {
      expect(await scan.tenants()).toContain(tenantId)
    } finally {
      await scan.close()
    }
    // Phase 70: the freshness gauge reads the oldest watermark per source, and nothing else.
    const gauge = new FreshnessGauge({ databaseUrl: url.toString() })
    try {
      expect((await gauge.refresh()).get('financial')).toBeGreaterThanOrEqual(0)
    } finally {
      await gauge.onModuleDestroy()
    }
    const relay = postgres(url.toString(), { max: 1 })
    try {
      await expect(relay`select seal_id from source_watermarks`).rejects.toThrow(
        /permission denied/,
      )
      await expect(relay`select * from consistency_runs`).rejects.toThrow(/permission denied/)
    } finally {
      await relay.end()
    }
  })
})
