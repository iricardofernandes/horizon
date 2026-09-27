import {
  EMPTY,
  InMemoryCommands,
  InMemoryReports,
  MemoryObjectStore,
} from 'test/repositories/in-memory-reports'
import { describe, expect, it } from 'vitest'
import type { Table } from '@/domain/exports'
import type { ObjectStore } from './ports/export-store'
import { reportTable } from './report-table'
import {
  ExportWorkUseCase,
  filterText,
  ManageExportSchedulesUseCase,
  ReadExportsUseCase,
  type Render,
  RequestExportUseCase,
} from './use-cases/exports'

const tenantId = '0196a1b2-0000-7000-8000-0000000000aa'
const context = { tenantId, actor: 'analyst-1', requestId: null }
let now = new Date('2026-09-27T12:00:00Z')
const clock = { now: () => now }
const key = () => ({ ...context, idempotencyKey: `export-${crypto.randomUUID()}` })
const HOUR = 3_600_000

function setup(options: { watermark?: Date | null } = {}) {
  now = new Date('2026-09-27T12:00:00Z')
  const reports = new InMemoryReports()
  reports.data = {
    ...EMPTY,
    'cash-position': {
      receivables: [{ currency: 'BRL', outstanding: '150050' }],
      payables: [],
      accounts: [{ accountId: 'acc-1', currency: 'BRL', balance: '-2500' }],
    },
  }
  reports.watermarkAll = options.watermark === undefined ? now : options.watermark
  const commands = new InMemoryCommands(reports)
  const store = new MemoryObjectStore()
  const rendered: { metadata: readonly (readonly [string, string])[]; table: Table }[] = []
  const render: Render = (format, metadata, table) => {
    rendered.push({ metadata, table })
    return Buffer.from(`${format}:${table.rows.length}`)
  }
  const work = new ExportWorkUseCase(
    commands,
    reports,
    store as unknown as ObjectStore,
    render,
    clock,
    {
      retentionMs: 72 * HOUR,
      leaseMs: 10 * 60_000,
      settleGraceMs: HOUR,
      batch: 20,
    },
  )
  return { reports, commands, store, rendered, work }
}

describe('asking for an export', () => {
  it('records the request once, and a worker writes the file with what it was asked', async () => {
    const { reports, commands, store, rendered, work } = setup()
    const request = new RequestExportUseCase(commands, clock)
    const asked = key()
    const input = {
      report: 'cash-position' as const,
      filter: { currency: 'BRL' },
      cutoff: new Date('2026-09-27T11:00:00Z'),
      format: 'csv' as const,
      locale: 'pt-BR' as const,
    }
    const job = await request.execute(asked, input)
    expect(job.value).toMatchObject({ status: 'requested', requestedBy: 'analyst-1' })
    expect((await request.execute(asked, input)).value).toEqual(job.value)
    expect(reports.jobs).toHaveLength(1)

    expect(await work.runTenant(tenantId)).toEqual({
      scheduled: 0,
      written: 1,
      failed: 0,
      expired: 0,
    })
    const [written] = reports.jobs
    expect(written).toMatchObject({
      status: 'ready',
      settled: true,
      rows: 2,
      bytes: 5,
      objectKey: `exports/${tenantId}/${written?.jobId}.csv`,
      expiresAt: new Date(now.getTime() + 72 * HOUR),
    })
    expect(written?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(store.files.size).toBe(1)
    expect(rendered[0]?.metadata).toEqual([
      ['report', 'cash-position'],
      ['cutoff', '2026-09-27T11:00:00.000Z'],
      ['settled', 'true'],
      ['filter', 'currency=BRL'],
      ['generated_at', now.toISOString()],
      ['locale', 'pt-BR'],
    ])
    expect(reports.requested.at(-1)?.filter).toEqual({ currency: 'BRL', from: null, to: null })
    expect(reports.audit).toEqual(['export.requested', 'export.written'])
  })

  it('refuses a future cutoff or a bad filter, and marks a file it could not write', async () => {
    const { reports, commands, store, work } = setup()
    const request = new RequestExportUseCase(commands, clock)
    const base = {
      report: 'cash-position' as const,
      format: 'xlsx' as const,
      locale: 'en' as const,
    }
    expect(
      (
        await request.execute(key(), {
          ...base,
          filter: {},
          cutoff: new Date('2027-01-01T00:00:00Z'),
        })
      ).isLeft(),
    ).toBe(true)
    expect(
      (await request.execute(key(), { ...base, filter: { from: 'x' }, cutoff: null })).isLeft(),
    ).toBe(true)
    await request.execute(key(), { ...base, filter: {}, cutoff: null })
    store.failing = true
    expect(await work.runTenant(tenantId)).toMatchObject({ written: 0, failed: 1 })
    expect(reports.jobs[0]).toMatchObject({
      status: 'failed',
      failure: 'the file could not be written',
    })
  })

  it('takes a running job back when its worker stopped, and removes files past retention', async () => {
    const { reports, commands, store, work } = setup()
    await new RequestExportUseCase(commands, clock).execute(key(), {
      report: 'cash-position',
      filter: {},
      cutoff: null,
      format: 'csv',
      locale: 'en',
    })
    const [job] = reports.jobs
    if (!job) throw new Error('no job')
    reports.jobs[0] = {
      ...job,
      status: 'running',
      startedAt: new Date(now.getTime() - 11 * 60_000),
    }
    expect((await work.runTenant(tenantId)).written).toBe(1)
    now = new Date(now.getTime() + 73 * HOUR)
    expect((await work.runTenant(tenantId)).expired).toBe(1)
    expect(reports.jobs[0]).toMatchObject({ status: 'expired', objectKey: null })
    expect(store.files.size).toBe(0)
  })
})

describe('reading exports', () => {
  it("shows a person their own exports, and an administrator everyone's", async () => {
    const { reports, commands, store, work } = setup()
    const request = new RequestExportUseCase(commands, clock)
    const input = {
      report: 'cash-position' as const,
      filter: {},
      cutoff: null,
      format: 'csv' as const,
      locale: 'en' as const,
    }
    const mine = await request.execute(key(), input)
    await request.execute({ ...key(), actor: 'someone-else' }, input)
    await work.runTenant(tenantId)
    const read = new ReadExportsUseCase(commands, store as unknown as ObjectStore)
    expect(await read.list(context, { administer: false }, 10)).toHaveLength(1)
    expect(await read.list(context, { administer: true }, 10)).toHaveLength(2)
    const jobId = (mine.value as { jobId: string }).jobId
    const other = reports.jobs.find((job) => job.requestedBy === 'someone-else')?.jobId ?? ''
    expect((await read.find(context, { administer: false }, jobId)).isRight()).toBe(true)
    expect((await read.find(context, { administer: false }, other)).isLeft()).toBe(true)
    expect((await read.find(context, { administer: true }, other)).isRight()).toBe(true)
    expect(await read.file(tenantId, jobId)).toMatchObject({
      name: 'cash-position-20260927-1200Z.csv',
      format: 'csv',
    })
    expect(await read.file(tenantId, 'missing')).toBeNull()
  })
})

describe('scheduled exports', () => {
  it('runs every overdue instant once, in order, each with its own cutoff', async () => {
    const { reports, commands, work } = setup()
    const schedules = new ManageExportSchedulesUseCase(commands, clock)
    const created = await schedules.create(key(), {
      report: 'cash-position',
      filter: {},
      format: 'csv',
      locale: 'pt-BR',
      cadence: 'daily',
      timeZone: 'UTC',
      since: new Date('2026-09-24T12:00:00Z'),
    })
    expect(created.value).toMatchObject({
      nextDueAt: new Date('2026-09-25T00:00:00Z'),
      active: true,
    })
    expect(await work.runDueSchedules(tenantId)).toBe(3)
    expect(reports.jobs.map((job) => job.cutoff.toISOString())).toEqual([
      '2026-09-25T00:00:00.000Z',
      '2026-09-26T00:00:00.000Z',
      '2026-09-27T00:00:00.000Z',
    ])
    expect(reports.schedules[0]?.nextDueAt.toISOString()).toBe('2026-09-28T00:00:00.000Z')
    // Looking again makes nothing twice.
    expect(await work.runDueSchedules(tenantId)).toBe(0)
  })

  it('waits for a due cutoff to settle, then runs it anyway after the grace', async () => {
    const { reports, commands, work } = setup({ watermark: new Date('2026-09-26T23:00:00Z') })
    await new ManageExportSchedulesUseCase(commands, clock).create(key(), {
      report: 'cash-position',
      filter: {},
      format: 'xlsx',
      locale: 'en',
      cadence: 'daily',
      timeZone: 'UTC',
      since: new Date('2026-09-26T12:00:00Z'),
    })
    now = new Date('2026-09-27T00:30:00Z')
    expect(await work.runDueSchedules(tenantId)).toBe(0)
    now = new Date('2026-09-27T01:30:00Z')
    expect(await work.runDueSchedules(tenantId)).toBe(1)
    await work.processNext(tenantId)
    expect(reports.jobs[0]).toMatchObject({ status: 'ready', settled: false })
  })

  it('pauses, resumes and removes a schedule, only for its owner or an administrator', async () => {
    const { reports, commands } = setup()
    const schedules = new ManageExportSchedulesUseCase(commands, clock)
    const base = {
      report: 'order-to-cash' as const,
      filter: {},
      format: 'csv' as const,
      locale: 'en' as const,
      cadence: 'monthly' as const,
      since: null,
    }
    expect((await schedules.create(key(), { ...base, timeZone: 'Mars/Olympus' })).isLeft()).toBe(
      true,
    )
    expect(
      (
        await schedules.create(key(), {
          ...base,
          timeZone: 'UTC',
          since: new Date('2026-07-01T00:00:00Z'),
        })
      ).isLeft(),
    ).toBe(true)
    expect(
      (await schedules.create(key(), { ...base, timeZone: 'UTC', filter: { to: 'x' } })).isLeft(),
    ).toBe(true)
    const created = await schedules.create(key(), { ...base, timeZone: 'America/Sao_Paulo' })
    const scheduleId = (created.value as { scheduleId: string }).scheduleId
    const stranger = { ...context, actor: 'someone-else' }
    expect(
      (await schedules.setActive(stranger, { administer: false }, scheduleId, false)).isLeft(),
    ).toBe(true)
    expect(
      (await schedules.setActive(context, { administer: false }, scheduleId, false)).value,
    ).toMatchObject({
      active: false,
    })
    expect(await schedules.list(stranger, { administer: false })).toHaveLength(0)
    expect(await schedules.list(stranger, { administer: true })).toHaveLength(1)
    expect((await schedules.remove(stranger, { administer: false }, scheduleId)).isLeft()).toBe(
      true,
    )
    expect((await schedules.remove(stranger, { administer: true }, scheduleId)).value).toEqual({
      scheduleId,
    })
    expect(reports.schedules).toHaveLength(0)
    expect(reports.audit).toEqual([
      'export-schedule.created',
      'export-schedule.paused',
      'export-schedule.removed',
    ])
  })
})

describe('report tables', () => {
  it('writes each report as rows of decimal amounts, and states its filter', () => {
    expect(
      reportTable('cash-position', {
        receivables: [{ currency: 'BRL', outstanding: '150050' }],
        payables: [{ currency: 'USD', outstanding: '100' }],
        accounts: [{ accountId: 'acc-1', currency: 'JPY', balance: '500' }],
      }).rows,
    ).toEqual([
      ['receivables', 'BRL', 'BRL', 1500.5],
      ['payables', 'USD', 'USD', 1],
      ['account', 'acc-1', 'JPY', 500],
    ])
    const flow = { raised: '100', settled: '50', open: '50' }
    expect(
      reportTable('order-to-cash', {
        currencies: [
          {
            currency: 'BRL',
            confirmed: { count: 2, total: '1000' },
            cancelledAfterConfirmation: 1,
            shipped: '800',
            returned: '0',
            receivables: flow,
            bankReconciled: '50',
          },
        ],
      }).rows,
    ).toEqual([['BRL', 2, 10, 1, 8, 0, 1, 0.5, 0.5, 0.5]])
    expect(
      reportTable('procure-to-pay', {
        currencies: [
          {
            currency: 'BRL',
            committed: { count: 1, total: '1200' },
            cancelledAfterApproval: 0,
            received: '1200',
            returns: 1,
            payables: flow,
          },
        ],
      }).rows,
    ).toEqual([['BRL', 1, 12, 0, 12, 1, 1, 0.5, 0.5]])
    const pipeline = reportTable('pipeline-to-revenue', {
      months: [
        {
          month: '2026-09',
          currency: 'BRL',
          won: { count: 1, value: '500' },
          lost: { count: 0, value: '0' },
          converted: { count: 1, value: '500' },
        },
      ],
      quotesAccepted: [{ currency: 'BRL', count: 2, total: '900' }],
    })
    expect(pipeline.rows).toEqual([
      ['month', '2026-09', 'BRL', 1, 5, 0, 0, 1, 5, null, null],
      ['quotes-accepted', null, 'BRL', null, null, null, null, null, null, 2, 9],
    ])
    expect(filterText({ currency: null, from: '2026-01', to: '2026-03' })).toBe(
      'from=2026-01; to=2026-03',
    )
    expect(filterText({ currency: null, from: null, to: null })).toBe('none')
  })
})
