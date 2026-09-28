import { InMemoryImportStore } from 'test/support/in-memory-import-store'
import { describe, expect, it } from 'vitest'
import { left, right } from '@/core/either'
import type { ImportLocale } from '@/domain/imports/import-job'
import { decimalOf, issue, valueIn } from '@/domain/imports/import-values'
import { TabularImportFiles } from '@/infrastructure/imports/tabular-files'
import { ImportJobs, type ImportSettings } from './imports'
import { ImportRowTakenError, type RowImporter } from './ports'

const TENANT = '01900000-0000-7000-8000-000000000001'
const OTHER = '01900000-0000-7000-8000-000000000002'

interface Thing {
  readonly name: string
  readonly code: string | null
  readonly amount: string | null
}

/** A module's importer, reduced to what the job contract needs from one. */
class ThingImporter implements RowImporter<Thing> {
  readonly kind = 'things'
  readonly fields = [
    { name: 'name', required: true, aliases: ['nome'], description: 'name' },
    { name: 'code', required: false, aliases: ['codigo'], description: 'code' },
    { name: 'amount', required: false, aliases: ['valor'], description: 'amount' },
  ]
  readonly written: { line: number; thing: Thing }[] = []
  crashAfter = Number.POSITIVE_INFINITY
  /** Called inside the "transaction", like the decorated unit of work. */
  onWrite: (jobId: string, line: number) => boolean = () => true

  async session(context: { numbers: ImportLocale }) {
    return {
      validate: (record: Readonly<Record<string, string | null>>) => {
        const name = valueIn(record, 'name')
        if (!name || name.length < 2) return left([issue('name', 'must have 2 characters')])
        const raw = valueIn(record, 'amount')
        const amount = raw === null ? null : decimalOf(raw, context.numbers)
        if (raw !== null && amount === null) return left([issue('amount', 'must be a number')])
        return right({ name, code: valueIn(record, 'code'), amount })
      },
      uniqueKey: (thing: Thing) => thing.code,
    }
  }

  async write(thing: Thing, key: { jobId: string; line: number }) {
    if (this.written.length >= this.crashAfter) throw new Error('killed')
    if (thing.name === 'refused') return left([issue(null, 'the module refused it')])
    if (!this.onWrite(key.jobId, key.line)) throw new ImportRowTakenError()
    this.written.push({ line: key.line, thing })
    return right(`ref-${key.line}`)
  }
}

const settings: ImportSettings = {
  maxRows: 100,
  maxBytes: 100_000,
  batchSize: 2,
  leaseMs: 60_000,
  retentionMs: 72 * 3_600_000,
}

function setup(start = new Date('2026-09-28T12:00:00Z')) {
  const store = new InMemoryImportStore()
  const importer = new ThingImporter()
  importer.onWrite = (jobId, line) => store.markInTransaction(TENANT, jobId, line)
  let now = start
  const clock = { now: () => now }
  const jobs = new ImportJobs(store, new TabularImportFiles(), [importer], clock, settings)
  return {
    store,
    importer,
    jobs,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
  }
}

const CSV = [
  'nome;codigo;valor',
  'Alfa;A;1.234,50',
  'x;B;2',
  'Beta;A;3',
  'refused;C;4',
  'Gama;;x',
  'Delta;D;5',
].join('\n')

function upload(jobs: ImportJobs, content = CSV, jobKey = 'key-1') {
  return jobs.upload({
    tenantId: TENANT,
    actor: 'user-1',
    kind: 'things',
    jobKey,
    fileName: 'things.csv',
    format: 'csv',
    locale: 'pt-BR',
    bytes: new TextEncoder().encode(content),
  })
}

async function uploaded(jobs: ImportJobs, content = CSV) {
  const outcome = await upload(jobs, content)
  if (outcome.isLeft()) throw new Error(outcome.value.message)
  return outcome.value.view.job.id
}

async function confirmed(jobs: ImportJobs, content = CSV) {
  const id = await uploaded(jobs, content)
  const view = await jobs.get(TENANT, id)
  const mapping = view.isRight() ? (view.value.job.mapping ?? {}) : {}
  expect((await jobs.map(TENANT, id, mapping)).isRight()).toBe(true)
  expect((await jobs.preview(TENANT, id)).isRight()).toBe(true)
  expect((await jobs.confirm(TENANT, id)).isRight()).toBe(true)
  return id
}

describe('uploading', () => {
  it('parses the file, suggests a mapping from the headers and counts every row', async () => {
    const { jobs } = setup()
    const outcome = await upload(jobs)
    expect(outcome.isRight() && outcome.value.created).toBe(true)
    if (outcome.isLeft()) return
    expect(outcome.value.view.job).toMatchObject({
      status: 'uploaded',
      columns: ['nome', 'codigo', 'valor'],
      mapping: { name: 'nome', code: 'codigo', amount: 'valor' },
      delimiter: ';',
    })
    expect(outcome.value.view.progress).toEqual({
      total: 6,
      valid: 0,
      written: 0,
      failed: 0,
      remaining: 6,
      cancelled: 0,
    })
  })

  it('returns the same job for the same key and file, and refuses the key with another file', async () => {
    const { jobs } = setup()
    const first = await upload(jobs)
    const again = await upload(jobs)
    expect(again.isRight() && !again.value.created).toBe(true)
    if (first.isRight() && again.isRight())
      expect(again.value.view.job.id).toBe(first.value.view.job.id)
    const other = await upload(jobs, `${CSV}\nEpsilon;E;1`)
    expect(other.isLeft() && other.value.kind).toBe('conflict')
  })

  it('refuses an unknown kind, an empty file, too many rows and too many bytes', async () => {
    const { jobs } = setup()
    const unknown = await jobs.upload({
      tenantId: TENANT,
      actor: 'u',
      kind: 'nothing',
      jobKey: 'k',
      fileName: 'a.csv',
      format: 'csv',
      locale: 'en',
      bytes: new Uint8Array([97]),
    })
    expect(unknown.isLeft() && unknown.value.kind).toBe('not-found')
    expect((await upload(jobs, 'nome;codigo\n\n', 'k2')).isLeft()).toBe(true)
    const many = ['nome', ...Array.from({ length: 101 }, (_, i) => `n${i}`)].join('\n')
    const tooMany = await upload(jobs, many, 'k3')
    expect(tooMany.isLeft() && tooMany.value.message).toContain('more than 100 rows')
    const huge = await upload(jobs, `nome\n${'a'.repeat(100_001)}`, 'k4')
    expect(huge.isLeft() && huge.value.message).toContain('larger than')
  })
})

describe('mapping and preview', () => {
  it('validates every row, refuses in-file duplicates, and previews the first errors', async () => {
    const { jobs } = setup()
    const id = await uploaded(jobs)
    const mapped = await jobs.map(TENANT, id, { name: 'nome', code: 'codigo', amount: 'valor' })
    expect(mapped.isRight() && mapped.value.progress).toEqual({
      total: 6,
      valid: 3,
      written: 0,
      failed: 3,
      remaining: 3,
      cancelled: 0,
    })
    const preview = await jobs.preview(TENANT, id)
    if (preview.isLeft()) throw new Error(preview.value.message)
    expect(preview.value.view.job.status).toBe('previewed')
    expect(preview.value.errors).toEqual([
      { line: 3, reasons: [{ field: 'name', message: 'must have 2 characters' }] },
      { line: 4, reasons: [{ field: null, message: 'repeats line 2 of this file' }] },
      { line: 6, reasons: [{ field: 'amount', message: 'must be a number' }] },
    ])
    expect(preview.value.sample[0]).toEqual({
      line: 2,
      values: { name: 'Alfa', code: 'A', amount: '1.234,50' },
    })
  })

  it('refuses a mapping without a required field or with an unknown column', async () => {
    const { jobs } = setup()
    const id = await uploaded(jobs)
    const missing = await jobs.map(TENANT, id, { code: 'codigo' })
    expect(missing.isLeft() && missing.value.message).toContain('name')
    const unknown = await jobs.map(TENANT, id, { name: 'Name' })
    expect(unknown.isLeft() && unknown.value.message).toContain('no column')
    const extra = await jobs.map(TENANT, id, { name: 'nome', color: 'codigo' })
    expect(extra.isLeft()).toBe(true)
  })

  it('confirms only after a preview, and a new mapping asks for a new preview', async () => {
    const { jobs } = setup()
    const id = await uploaded(jobs)
    expect((await jobs.confirm(TENANT, id)).isLeft()).toBe(true)
    expect((await jobs.preview(TENANT, id)).isLeft()).toBe(true)
    await jobs.map(TENANT, id, { name: 'nome' })
    await jobs.preview(TENANT, id)
    await jobs.map(TENANT, id, { name: 'nome', code: 'codigo' })
    expect((await jobs.confirm(TENANT, id)).isLeft()).toBe(true)
    await jobs.preview(TENANT, id)
    expect((await jobs.confirm(TENANT, id)).isRight()).toBe(true)
    expect((await jobs.map(TENANT, id, { name: 'nome' })).isLeft()).toBe(true)
  })
})

describe('writing', () => {
  it('writes the valid rows in batches and ends with every row accounted for', async () => {
    const { jobs, importer } = setup()
    const id = await confirmed(jobs)
    const work = await jobs.runTenant(TENANT)
    expect(work).toMatchObject({ written: 2, rejected: 1, finished: 1 })
    expect(importer.written.map((row) => row.line)).toEqual([2, 7])
    expect(importer.written[0]?.thing.amount).toBe('1234.50')
    const view = await jobs.get(TENANT, id)
    if (view.isLeft()) throw new Error()
    expect(view.value.job.status).toBe('completed-with-failures')
    expect(view.value.progress).toEqual({
      total: 6,
      valid: 3,
      written: 2,
      failed: 4,
      remaining: 0,
      cancelled: 0,
    })
    expect(view.value.job.failuresUntil?.toISOString()).toBe('2026-10-01T12:00:00.000Z')
  })

  it('completes a file without failures and forgets its rows at once', async () => {
    const { jobs, store } = setup()
    const id = await confirmed(jobs, 'nome;codigo\nAlfa;A\nBeta;B\nGama;C')
    await jobs.runTenant(TENANT)
    const view = await jobs.get(TENANT, id)
    expect(view.isRight() && view.value.job.status).toBe('completed')
    expect(view.isRight() && view.value.job.purgedAt).not.toBeNull()
    expect((await store.rows(TENANT, id, {})).every((row) => row.cells.length === 0)).toBe(true)
    const failures = await jobs.failures(TENANT, id)
    expect(failures.isRight()).toBe(true)
  })

  it('resumes after a crash, once the lease lapses, without writing a row twice', async () => {
    const { jobs, importer, advance } = setup()
    const id = await confirmed(jobs, 'nome;codigo\nA1;1\nA2;2\nA3;3\nA4;4\nA5;5')
    importer.crashAfter = 3
    await expect(jobs.runTenant(TENANT)).rejects.toThrow('killed')
    expect(importer.written).toHaveLength(3)
    importer.crashAfter = Number.POSITIVE_INFINITY
    expect(await jobs.runTenant(TENANT)).toMatchObject({ written: 0 })
    advance(61_000)
    expect(await jobs.runTenant(TENANT)).toMatchObject({ written: 2, finished: 1 })
    expect(importer.written.map((row) => row.line)).toEqual([2, 3, 4, 5, 6])
    const view = await jobs.get(TENANT, id)
    expect(view.isRight() && view.value.job.status).toBe('completed')
  })

  it('skips a row another writer took, without counting it twice', async () => {
    const { jobs, importer, store } = setup()
    const id = await confirmed(jobs, 'nome\nAlfa\nBeta')
    importer.onWrite = (jobId, line) => {
      if (line === 2) store.markInTransaction(TENANT, jobId, line)
      return store.markInTransaction(TENANT, jobId, line)
    }
    const work = await jobs.runTenant(TENANT)
    expect(work.written).toBe(1)
    const view = await jobs.get(TENANT, id)
    expect(view.isRight() && view.value.progress.written).toBe(2)
  })
})

describe('cancelling and retention', () => {
  it('cancels a running job: unwritten rows are cancelled and nothing more is written', async () => {
    const { jobs, importer } = setup()
    const id = await confirmed(jobs)
    const cancelled = await jobs.cancel(TENANT, id)
    if (cancelled.isLeft()) throw new Error()
    expect(cancelled.value.job.status).toBe('cancelled')
    expect(cancelled.value.progress).toMatchObject({ remaining: 0, cancelled: 3, failed: 3 })
    await jobs.runTenant(TENANT)
    expect(importer.written).toHaveLength(0)
    expect((await jobs.cancel(TENANT, id)).isLeft()).toBe(true)
  })

  it('downloads the failures until retention, then answers gone', async () => {
    const { jobs, advance } = setup()
    const id = await confirmed(jobs)
    await jobs.runTenant(TENANT)
    const file = await jobs.failures(TENANT, id)
    if (file.isLeft()) throw new Error()
    const text = new TextDecoder().decode(file.value.bytes)
    expect(file.value.fileName).toBe('things-falhas.csv')
    expect(text).toContain('nome;codigo;valor;linha;motivo')
    expect(text).toContain('x;B;2;3;name: must have 2 characters')
    expect(text).toContain('refused;C;4;5;the module refused it')
    advance(72 * 3_600_000)
    expect(await jobs.runTenant(TENANT)).toMatchObject({ purged: 1 })
    const gone = await jobs.failures(TENANT, id)
    expect(gone.isLeft() && gone.value.kind).toBe('gone')
  })

  it('abandons an import nobody confirmed, after retention', async () => {
    const { jobs, advance } = setup()
    const id = await uploaded(jobs)
    advance(73 * 3_600_000)
    expect(await jobs.runTenant(TENANT)).toMatchObject({ abandoned: 1 })
    const view = await jobs.get(TENANT, id)
    expect(view.isRight() && view.value.progress).toMatchObject({ remaining: 0, cancelled: 6 })
  })
})

describe('tenancy and listing', () => {
  it('lists the kinds, and never shows one tenant the jobs of another', async () => {
    const { jobs } = setup()
    const id = await uploaded(jobs)
    expect(jobs.kinds().map((kind) => kind.kind)).toEqual(['things'])
    expect((await jobs.list(TENANT)).map((view) => view.job.id)).toEqual([id])
    expect(await jobs.list(TENANT, 'other')).toEqual([])
    expect(await jobs.list(OTHER)).toEqual([])
    expect((await jobs.get(OTHER, id)).isLeft()).toBe(true)
    for (const result of [
      await jobs.map(OTHER, id, { name: 'nome' }),
      await jobs.preview(OTHER, id),
      await jobs.confirm(OTHER, id),
      await jobs.cancel(OTHER, id),
      await jobs.failures(OTHER, id),
    ])
      expect(result.isLeft() && result.value.kind).toBe('not-found')
  })
})
