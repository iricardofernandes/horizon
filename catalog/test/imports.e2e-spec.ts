import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ItemImporter, PriceImporter, UnitImporter } from '@/application/imports/catalog-importers'
import { ImportJobs } from '@/application/imports/imports'
import type { RowKey } from '@/application/imports/ports'
import { CatalogDatabase } from '@/infrastructure/database/drizzle/catalog-database'
import { PLAIN_ROWS, SqlImportStore } from '@/infrastructure/database/drizzle/import-store'
import { RowWritingUnitOfWork } from '@/infrastructure/imports/catalog-rows'
import { RelayImportScan } from '@/infrastructure/imports/import-worker'
import { TabularImportFiles, writeXlsx } from '@/infrastructure/imports/tabular-files'

let database: CatalogDatabase
let owner: ReturnType<typeof postgres>
let relayUrl: string
const IMPORTER = randomUUID()

beforeAll(() => {
  database = new CatalogDatabase({ url: process.env.DATABASE_URL ?? '' })
  owner = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  relayUrl = (process.env.DATABASE_URL ?? '').replace(/\/\/[^:]+:[^@]+@/, '//horizon_relay:test@')
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), owner?.end()])
})

function movingClock() {
  let now = new Date()
  return {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
  }
}

function jobsWith(clock: { now: () => Date }, crashAfter = Number.POSITIVE_INFINITY) {
  let writes = 0
  const rows = (key: RowKey) => {
    writes += 1
    if (writes > crashAfter) throw new Error('killed')
    return new RowWritingUnitOfWork(database, key)
  }
  return new ImportJobs(
    new SqlImportStore(database, PLAIN_ROWS),
    new TabularImportFiles(),
    [
      new UnitImporter(clock, rows),
      new ItemImporter(database, clock, rows),
      new PriceImporter(database, clock, rows),
    ],
    clock,
    { maxRows: 10_000, maxBytes: 5_000_000, batchSize: 3, leaseMs: 60_000, retentionMs: 3_600_000 },
  )
}

async function run(
  jobs: ImportJobs,
  tenantId: string,
  kind: string,
  file: { format: 'csv' | 'xlsx'; bytes: Uint8Array; locale?: 'pt-BR' | 'en' },
) {
  const uploaded = await jobs.upload({
    tenantId,
    actor: IMPORTER,
    kind,
    jobKey: `${kind}-${randomUUID()}`,
    fileName: `${kind}.${file.format}`,
    format: file.format,
    locale: file.locale ?? 'pt-BR',
    bytes: file.bytes,
  })
  if (uploaded.isLeft()) throw new Error(uploaded.value.message)
  const { id, mapping } = uploaded.value.view.job
  const mapped = await jobs.map(tenantId, id, mapping ?? {})
  if (mapped.isLeft()) throw new Error(mapped.value.message)
  await jobs.preview(tenantId, id)
  await jobs.confirm(tenantId, id)
  return id
}

const csv = (text: string) => ({ format: 'csv' as const, bytes: new TextEncoder().encode(text) })

async function count(table: string, tenantId: string): Promise<number> {
  const [row] = await owner`select count(*)::int as count from ${owner(table)}
    where tenant_id = ${tenantId}`
  return Number(row?.count)
}

describe('importing a catalogue', () => {
  it('imports units, then items by unit code, then prices, each with its failures', async () => {
    const tenantId = randomUUID()
    const jobs = jobsWith(movingClock())
    const units = await run(
      jobs,
      tenantId,
      'units',
      csv('Código;Nome;Decimais\nUN;Unidade;0\nKG;Quilo;3\nkg;Repetida;0'),
    )
    await jobs.runTenant(tenantId)
    const unitsView = await jobs.get(tenantId, units)
    expect(unitsView.isRight() && unitsView.value.progress).toMatchObject({ written: 2, failed: 1 })

    const items = await run(jobs, tenantId, 'items', {
      format: 'xlsx',
      locale: 'en',
      bytes: writeXlsx(
        [
          ['SKU', 'Name', 'Unit', 'NCM'],
          ['CAF-1', 'Café em grãos', 'KG', '09012100'],
          ['CAF-2', 'Café moído', 'KG', ''],
          ['XIC-1', 'Xícara', 'CX', ''],
        ],
        'Items',
      ),
    })
    await jobs.runTenant(tenantId)
    const itemsView = await jobs.get(tenantId, items)
    expect(itemsView.isRight() && itemsView.value.progress).toEqual({
      total: 3,
      valid: 2,
      written: 2,
      failed: 1,
      remaining: 0,
      cancelled: 0,
    })
    const failures = await jobs.failures(tenantId, items)
    if (failures.isLeft()) throw new Error()
    expect(failures.value.fileName).toBe('items-failures.xlsx')

    const prices = await run(
      jobs,
      tenantId,
      'prices',
      csv(
        'Lista;Moeda;SKU;Preço\nVarejo;BRL;CAF-1;49,90\nVarejo;BRL;CAF-2;39,9\nVarejo;BRL;NOPE;1',
      ),
    )
    await jobs.runTenant(tenantId)
    const pricesView = await jobs.get(tenantId, prices)
    expect(pricesView.isRight() && pricesView.value.progress).toMatchObject({
      written: 2,
      failed: 1,
    })
    const [list] = await owner`select id from price_lists where tenant_id = ${tenantId}
      and name = 'Varejo'`
    const amounts = await owner`select amount::text as amount from prices
      where price_list_id = ${list?.id} order by amount`
    expect(amounts.map((row) => row.amount)).toEqual(['3990', '4990'])

    const audit = await owner`select actor_id, action from audit_log where tenant_id = ${tenantId}
      and action = 'catalog.item.created'`
    expect(audit.map((row) => row.actor_id)).toEqual([IMPORTER, IMPORTER])
  })
})

describe('writing each row once', () => {
  it('finishes after a worker dies mid-import, with every item written once', async () => {
    const tenantId = randomUUID()
    const clock = movingClock()
    await database.provisionTenant(tenantId)
    const setup = jobsWith(clock)
    await run(setup, tenantId, 'units', csv('code;name\nUN;Unidade'))
    await setup.runTenant(tenantId)

    const lines = Array.from({ length: 10 }, (_, index) => `SKU-${index};Item ${index};UN`)
    const dying = jobsWith(clock, 4)
    const id = await run(dying, tenantId, 'items', csv(['sku;name;unit', ...lines].join('\n')))
    await expect(dying.runTenant(tenantId)).rejects.toThrow('killed')
    expect(await count('catalog_items', tenantId)).toBe(4)

    clock.advance(61_000)
    const successor = jobsWith(clock)
    expect(await successor.runTenant(tenantId)).toMatchObject({ written: 6, finished: 1 })
    expect(await count('catalog_items', tenantId)).toBe(10)
    const view = await successor.get(tenantId, id)
    expect(view.isRight() && view.value.job.status).toBe('completed')
  })
})

describe('isolation', () => {
  it('lets the relay role find tenants with work, and read nothing else', async () => {
    const tenantId = randomUUID()
    const jobs = jobsWith(movingClock())
    await run(jobs, tenantId, 'units', csv('code;name\nUN;Unidade'))
    expect(await jobs.list(randomUUID())).toEqual([])
    const scan = new RelayImportScan(relayUrl)
    try {
      expect(await scan.tenantsWithWork(new Date(), new Date(0))).toContain(tenantId)
    } finally {
      await scan.close()
    }
    const relay = postgres(relayUrl, { max: 1 })
    try {
      await expect(relay`select mapping from import_jobs`).rejects.toThrow(/permission denied/)
      await expect(relay`select cells from import_rows`).rejects.toThrow(/permission denied/)
    } finally {
      await relay.end()
    }
  })
})
