import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApplySealUseCase } from '@/application/use-cases/apply-seal'
import {
  ExportWorkUseCase,
  ManageExportSchedulesUseCase,
  ReadExportsUseCase,
  RequestExportUseCase,
} from '@/application/use-cases/exports'
import { JournalEventUseCase } from '@/application/use-cases/journal-event'
import { ReportingDatabase } from '@/infrastructure/database/drizzle/reporting-database'
import { RelayExportWorkScan } from '@/infrastructure/exports/export-worker'
import { FileObjectStore } from '@/infrastructure/exports/object-stores'
import { writeFile } from '@/infrastructure/exports/writers'

/**
 * Exports end to end against real PostgreSQL and a directory store (Phase 63): requested,
 * written once however many workers look, read back, scheduled, caught up and expired.
 */
let now = new Date()
const clock = { now: () => now }
let database: ReportingDatabase
let administrator: ReturnType<typeof postgres>
let root: string
let store: FileObjectStore
let scan: RelayExportWorkScan

beforeAll(async () => {
  database = new ReportingDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  root = await mkdtemp(join(tmpdir(), 'horizon-exports-'))
  store = new FileObjectStore(root)
  scan = new RelayExportWorkScan(
    (process.env.DATABASE_URL ?? '').replace(/\/\/[^:]+:[^@]+@/, '//horizon_relay:test@'),
  )
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end(), scan?.close()])
})

function worker() {
  return new ExportWorkUseCase(database.commands, database.reports, store, writeFile, clock, {
    retentionMs: 72 * 3_600_000,
    leaseMs: 600_000,
    settleGraceMs: 3_600_000,
    batch: 20,
  })
}

async function seeded(tenantId: string) {
  await new JournalEventUseCase(database).execute(
    {
      eventId: randomUUID(),
      tenantId,
      eventType: 'financial.receivable.posted',
      eventVersion: 1,
      occurredAt: new Date(now.getTime() - 3_600_000).toISOString(),
      traceId: 'd'.repeat(32),
      payload: {
        titleId: randomUUID(),
        total: { amount: '123450', currency: 'BRL' },
        origin: { type: 'manual' },
      },
    },
    'replay',
  )
  const sealer = new ApplySealUseCase(database, clock)
  for (const [source, count] of [
    ['financial', 1],
    ['treasury', 0],
  ] as const)
    await sealer.execute({
      sealId: randomUUID(),
      source,
      tenantId,
      through: new Date(now.getTime() - 10 * 60_000),
      count,
      sealedAt: now,
    })
}

describe('export jobs', () => {
  it('writes a requested report once, whatever the number of workers, and reads it back', async () => {
    now = new Date()
    const tenantId = randomUUID()
    await seeded(tenantId)
    const context = { tenantId, actor: 'analyst-1', requestId: null }
    const request = new RequestExportUseCase(database.commands, clock)
    const cutoff = new Date(now.getTime() - 20 * 60_000)
    const csv = await request.execute(
      { ...context, idempotencyKey: `export-${randomUUID()}` },
      { report: 'cash-position', filter: {}, cutoff, format: 'csv', locale: 'pt-BR' },
    )
    const xlsx = await request.execute(
      { ...context, idempotencyKey: `export-${randomUUID()}` },
      { report: 'cash-position', filter: {}, cutoff, format: 'xlsx', locale: 'en' },
    )
    expect(await scan.tenantsWithWork(now, new Date(now.getTime() - 600_000))).toContain(tenantId)

    const results = await Promise.all([worker().runTenant(tenantId), worker().runTenant(tenantId)])
    expect(results.reduce((sum, result) => sum + result.written, 0)).toBe(2)
    const [row] = await administrator`select count(*)::int as ready from export_jobs
      where tenant_id = ${tenantId} and status = 'ready'`
    expect(row?.ready).toBe(2)

    const read = new ReadExportsUseCase(database.commands, store)
    const csvFile = await read.file(tenantId, (csv.value as { jobId: string }).jobId)
    const text = csvFile?.bytes.toString('utf8') ?? ''
    expect(text).toContain('report;cash-position')
    expect(text).toContain('settled;true')
    expect(text).toContain('receivables;BRL;BRL;1234,5')
    const xlsxFile = await read.file(tenantId, (xlsx.value as { jobId: string }).jobId)
    const sheet = strFromU8(
      unzipSync(new Uint8Array(xlsxFile?.bytes ?? Buffer.alloc(0)))['xl/worksheets/sheet1.xml'] ??
        new Uint8Array(),
    )
    expect(sheet).toContain('<v>1234.5</v>')
    const [job] = await administrator`select object_key, sha256 from export_jobs
      where id = ${(csv.value as { jobId: string }).jobId}`
    expect(await readFile(join(root, String(job?.object_key)))).toEqual(csvFile?.bytes)
    expect(await scan.tenantsWithWork(now, new Date(now.getTime() - 600_000))).not.toContain(
      tenantId,
    )
  })

  it('runs a missed schedule once per due instant, then removes files past retention', async () => {
    now = new Date('2026-09-27T12:00:00Z')
    const tenantId = randomUUID()
    const context = { tenantId, actor: 'analyst-1', requestId: null }
    await new ManageExportSchedulesUseCase(database.commands, clock).create(
      { ...context, idempotencyKey: `schedule-${randomUUID()}` },
      {
        report: 'order-to-cash',
        filter: {},
        format: 'csv',
        locale: 'en',
        cadence: 'daily',
        timeZone: 'America/Sao_Paulo',
        since: new Date('2026-09-25T12:00:00Z'),
      },
    )
    // Nothing is sealed: each due instant waits out the grace, then runs, marked unsettled.
    const results = await Promise.all([worker().runTenant(tenantId), worker().runTenant(tenantId)])
    expect(results.reduce((sum, result) => sum + result.scheduled, 0)).toBe(2)
    const runs = await administrator`select cutoff, status, settled from export_jobs
      where tenant_id = ${tenantId} order by cutoff`
    expect(runs.map((run) => (run.cutoff as Date).toISOString())).toEqual([
      '2026-09-26T03:00:00.000Z',
      '2026-09-27T03:00:00.000Z',
    ])
    expect(runs.every((run) => run.status === 'ready' && run.settled === false)).toBe(true)

    now = new Date(now.getTime() + 73 * 3_600_000)
    const later = await worker().runTenant(tenantId)
    // The first two files expired, and the three days since were caught up as new runs.
    expect(later).toMatchObject({ expired: 2, scheduled: 3, written: 3 })
    const after = await administrator`select cutoff, status, object_key from export_jobs
      where tenant_id = ${tenantId} order by cutoff`
    expect(after.map((run) => run.status)).toEqual([
      'expired',
      'expired',
      'ready',
      'ready',
      'ready',
    ])
    expect(after.slice(0, 2).every((run) => run.object_key === null)).toBe(true)
  })

  it("keeps one tenant's exports from another, and the relay role from their content", async () => {
    now = new Date()
    const tenantId = randomUUID()
    await new RequestExportUseCase(database.commands, clock).execute(
      { tenantId, actor: 'a', requestId: null, idempotencyKey: `export-${randomUUID()}` },
      { report: 'procure-to-pay', filter: {}, cutoff: null, format: 'csv', locale: 'en' },
    )
    const read = new ReadExportsUseCase(database.commands, store)
    expect(
      await read.list(
        { tenantId: randomUUID(), actor: 'a', requestId: null },
        { administer: true },
        10,
      ),
    ).toEqual([])
    const relay = postgres(
      (process.env.DATABASE_URL ?? '').replace(/\/\/[^:]+:[^@]+@/, '//horizon_relay:test@'),
      { max: 1 },
    )
    try {
      await expect(relay`select report, filter, requested_by from export_jobs`).rejects.toThrow(
        /permission denied/,
      )
    } finally {
      await relay.end()
    }
  })
})
