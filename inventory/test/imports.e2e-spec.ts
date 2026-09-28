import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ImportJobs } from '@/application/imports/imports'
import { OpeningStockImporter } from '@/application/imports/opening-stock-importer'
import type { RowKey } from '@/application/imports/ports'
import { CreateWarehouseUseCase } from '@/application/use-cases/manage-inventory'
import { PLAIN_ROWS, SqlImportStore } from '@/infrastructure/database/drizzle/import-store'
import { InventoryDatabase } from '@/infrastructure/database/drizzle/inventory-database'
import { RelayImportScan } from '@/infrastructure/imports/import-worker'
import { RowWritingUnitOfWork } from '@/infrastructure/imports/inventory-rows'
import { TabularImportFiles } from '@/infrastructure/imports/tabular-files'

let database: InventoryDatabase
let administrator: ReturnType<typeof postgres>
let relayUrl: string

beforeAll(() => {
  database = new InventoryDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  relayUrl = (process.env.DATABASE_URL ?? '').replace(/\/\/[^:]+:[^@]+@/, '//horizon_relay:test@')
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end()])
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
  const importer = new OpeningStockImporter(database, clock, (key: RowKey) => {
    writes += 1
    if (writes > crashAfter) throw new Error('killed')
    return new RowWritingUnitOfWork(database, key)
  })
  return new ImportJobs(
    new SqlImportStore(database, PLAIN_ROWS),
    new TabularImportFiles(),
    [importer],
    clock,
    { maxRows: 10_000, maxBytes: 5_000_000, batchSize: 3, leaseMs: 60_000, retentionMs: 3_600_000 },
  )
}

async function warehouse(tenantId: string, name = 'Central') {
  const created = await new CreateWarehouseUseCase(database, { now: () => new Date() }).execute({
    tenantId,
    name,
  })
  if (created.isLeft()) throw created.value
  return created.value.warehouseId
}

async function start(jobs: ImportJobs, tenantId: string, content: string) {
  const uploaded = await jobs.upload({
    tenantId,
    actor: 'importer',
    kind: 'opening-stock',
    jobKey: randomUUID(),
    fileName: 'saldos.csv',
    format: 'csv',
    locale: 'pt-BR',
    bytes: new TextEncoder().encode(content),
  })
  if (uploaded.isLeft()) throw new Error(uploaded.value.message)
  const { id, mapping } = uploaded.value.view.job
  const mapped = await jobs.map(tenantId, id, mapping ?? {})
  if (mapped.isLeft()) throw new Error(mapped.value.message)
  await jobs.preview(tenantId, id)
  await jobs.confirm(tenantId, id)
  return id
}

async function onHand(tenantId: string): Promise<number> {
  const [row] = await administrator`select coalesce(sum(on_hand), 0)::bigint as total
    from stock_balances where tenant_id = ${tenantId}`
  return Number(row?.total)
}

describe('importing opening stock', () => {
  it('receives each valid row once, reports the invalid ones, and the counts add up', async () => {
    const tenantId = randomUUID()
    await warehouse(tenantId)
    const [first, second] = [randomUUID(), randomUUID()]
    const jobs = jobsWith(movingClock())
    const id = await start(
      jobs,
      tenantId,
      [
        'Depósito;Item;Quantidade;Custo unitário;Moeda',
        `Central;${first};10;2,50;BRL`,
        `Central;${second};5,5;10;BRL`,
        `Filial;${first};1;1;BRL`,
        `Central;${first};10;2,50;BRL`,
      ].join('\n'),
    )
    await jobs.runTenant(tenantId)
    const view = await jobs.get(tenantId, id)
    expect(view.isRight() && view.value.progress).toEqual({
      total: 4,
      valid: 2,
      written: 2,
      failed: 2,
      remaining: 0,
      cancelled: 0,
    })
    // Quantities are stored in millionths.
    expect(await onHand(tenantId)).toBe(15_500_000)
    const movements = await administrator`select count(*)::int as count from stock_movements
      where tenant_id = ${tenantId}`
    expect(movements[0]?.count).toBe(2)
  })

  it('finishes after a worker dies mid-import, with every balance received once', async () => {
    const tenantId = randomUUID()
    await warehouse(tenantId)
    const clock = movingClock()
    const lines = Array.from({ length: 9 }, () => `Central;${randomUUID()};1;1;BRL`)
    const dying = jobsWith(clock, 5)
    const id = await start(
      dying,
      tenantId,
      ['warehouse;itemId;quantity;unitCost;currency', ...lines].join('\n'),
    )
    await expect(dying.runTenant(tenantId)).rejects.toThrow('killed')
    expect(await onHand(tenantId)).toBe(5_000_000)
    clock.advance(61_000)
    const successor = jobsWith(clock)
    expect(await successor.runTenant(tenantId)).toMatchObject({ written: 4, finished: 1 })
    expect(await onHand(tenantId)).toBe(9_000_000)
    const view = await successor.get(tenantId, id)
    expect(view.isRight() && view.value.job.status).toBe('completed')
  })

  it('lets the relay role find tenants with work, and read nothing else', async () => {
    const tenantId = randomUUID()
    await warehouse(tenantId)
    await start(
      jobsWith(movingClock()),
      tenantId,
      `warehouse;itemId;quantity;unitCost;currency\nCentral;${randomUUID()};1;1;BRL`,
    )
    const scan = new RelayImportScan(relayUrl)
    try {
      expect(await scan.tenantsWithWork(new Date(), new Date(0))).toContain(tenantId)
    } finally {
      await scan.close()
    }
    const relay = postgres(relayUrl, { max: 1 })
    try {
      await expect(relay`select cells from import_rows`).rejects.toThrow(/permission denied/)
    } finally {
      await relay.end()
    }
  })
})
