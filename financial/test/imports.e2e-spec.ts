import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FinancialModuleEventHandlers } from '@/application/consume-module-events'
import { ImportJobs } from '@/application/imports/imports'
import type { RowKey } from '@/application/imports/ports'
import { TitleImporter } from '@/application/imports/title-importer'
import { DefineCategoryUseCase } from '@/application/use-cases/manage-dimensions'
import { FinancialDatabase } from '@/infrastructure/database/drizzle/financial-database'
import { PLAIN_ROWS, SqlImportStore } from '@/infrastructure/database/drizzle/import-store'
import { RowWritingUnitOfWork } from '@/infrastructure/imports/financial-rows'
import { RelayImportScan } from '@/infrastructure/imports/import-worker'
import { TabularImportFiles } from '@/infrastructure/imports/tabular-files'

let database: FinancialDatabase
let administrator: ReturnType<typeof postgres>
let handlers: FinancialModuleEventHandlers
let relayUrl: string

beforeAll(() => {
  database = new FinancialDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  handlers = new FinancialModuleEventHandlers(database, { now: () => new Date() })
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

/** The workspace's chart: a revenue and an expense category, by code. */
async function categories(tenantId: string): Promise<void> {
  const define = new DefineCategoryUseCase(database, { now: () => new Date() })
  for (const [code, nature] of [
    ['1.01', 'revenue'],
    ['2.01', 'expense'],
  ] as const) {
    const defined = await define.execute({ tenantId, code, name: code, nature })
    if (defined.isLeft()) throw defined.value
  }
}

/** Parties tells Financial about a party the way it always does: an event. */
async function party(tenantId: string, roles: string[]): Promise<string> {
  await categories(tenantId).catch(() => undefined)
  const partyId = randomUUID()
  const envelope: EventEnvelope = {
    eventId: randomUUID(),
    tenantId,
    eventType: 'parties.party.registered',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    traceId: randomBytes(16).toString('hex'),
    payload: {
      partyId,
      kind: 'organization',
      legalName: 'Acme Comércio Ltda',
      tradeName: null,
      email: 'finance@acme.example',
      phone: '+5511999990000',
      address: 'Rua Um, 42, São Paulo',
      roles,
    },
  }
  await handlers.handlers['parties.party.registered']?.(envelope)
  return partyId
}

function jobsWith(clock: { now: () => Date }, crashAfter = Number.POSITIVE_INFINITY) {
  let posts = 0
  const rows = (key: RowKey) => {
    posts += 1
    if (posts > crashAfter) throw new Error('killed')
    return new RowWritingUnitOfWork(database, key)
  }
  return new ImportJobs(
    new SqlImportStore(database, PLAIN_ROWS),
    new TabularImportFiles(),
    [
      new TitleImporter('receivable', database, clock, rows),
      new TitleImporter('payable', database, clock, rows),
    ],
    clock,
    { maxRows: 10_000, maxBytes: 5_000_000, batchSize: 2, leaseMs: 60_000, retentionMs: 3_600_000 },
  )
}

async function start(jobs: ImportJobs, tenantId: string, kind: string, lines: string[]) {
  const uploaded = await jobs.upload({
    tenantId,
    actor: 'importer',
    kind,
    jobKey: randomUUID(),
    fileName: `${kind}.csv`,
    format: 'csv',
    locale: 'pt-BR',
    bytes: new TextEncoder().encode(
      ['Parceiro;Documento;Emissão;Vencimento;Valor;Moeda;Categoria', ...lines].join('\n'),
    ),
  })
  if (uploaded.isLeft()) throw new Error(uploaded.value.message)
  const { id, mapping } = uploaded.value.view.job
  const mapped = await jobs.map(tenantId, id, mapping ?? {})
  if (mapped.isLeft()) throw new Error(mapped.value.message)
  await jobs.preview(tenantId, id)
  await jobs.confirm(tenantId, id)
  return id
}

async function titles(tenantId: string) {
  return administrator`select document_number, status, approval_state from titles
    where tenant_id = ${tenantId} order by document_number`
}

describe('importing open titles', () => {
  it('posts each valid receivable once and refuses a party that is not a customer', async () => {
    const tenantId = randomUUID()
    const customer = await party(tenantId, ['customer'])
    const supplier = await party(tenantId, ['supplier'])
    const jobs = jobsWith(movingClock())
    const id = await start(jobs, tenantId, 'receivables', [
      `${customer};NF-1;01/09/2026;30/10/2026;1.500,75;BRL;1.01`,
      `${customer};NF-2;01/09/2026;30/11/2026;99;BRL;1.01`,
      `${supplier};NF-3;01/09/2026;30/11/2026;10;BRL;1.01`,
      `${customer};NF-1;01/09/2026;30/10/2026;1;BRL;1.01`,
      `${randomUUID()};NF-4;01/09/2026;30/11/2026;10;BRL;1.01`,
    ])
    await jobs.runTenant(tenantId)
    const view = await jobs.get(tenantId, id)
    expect(view.isRight() && view.value.progress).toEqual({
      total: 5,
      valid: 4,
      written: 2,
      failed: 3,
      remaining: 0,
      cancelled: 0,
    })
    expect((await titles(tenantId)).map((row) => [row.document_number, row.status])).toEqual([
      ['NF-1', 'posted'],
      ['NF-2', 'posted'],
    ])
    const [open] = await administrator`select sum(outstanding)::text as total
      from title_installments where tenant_id = ${tenantId}`
    expect(open?.total).toBe('159975')
    const failures = await jobs.failures(tenantId, id)
    if (failures.isLeft()) throw new Error()
    const text = new TextDecoder().decode(failures.value.bytes)
    expect(text).toContain('not registered as a customer')
    expect(text).toContain('repeats line 2')
    expect(text).toContain('party was not found')
  })

  it('asks for approval of an imported payable the policy holds, and never posts it', async () => {
    const tenantId = randomUUID()
    const supplier = await party(tenantId, ['supplier'])
    const jobs = jobsWith(movingClock())
    await start(jobs, tenantId, 'payables', [`${supplier};B-1;01/09/2026;30/10/2026;500;BRL;2.01`])
    await jobs.runTenant(tenantId)
    expect((await titles(tenantId)).map((row) => [row.status, row.approval_state])).toEqual([
      ['draft', 'pending'],
    ])
  })

  it('finishes after a worker dies mid-import, with every title posted once', async () => {
    const tenantId = randomUUID()
    const customer = await party(tenantId, ['customer'])
    const clock = movingClock()
    const lines = Array.from(
      { length: 6 },
      (_, index) => `${customer};NF-${index};01/09/2026;30/10/2026;10;BRL;1.01`,
    )
    const dying = jobsWith(clock, 3)
    const id = await start(dying, tenantId, 'receivables', lines)
    await expect(dying.runTenant(tenantId)).rejects.toThrow('killed')
    const partway = await titles(tenantId)
    expect(partway.filter((row) => row.status === 'posted')).toHaveLength(3)
    // The fourth row was drafted before its worker died; the successor replays the draft.
    expect(partway).toHaveLength(4)
    clock.advance(61_000)
    const successor = jobsWith(clock)
    expect(await successor.runTenant(tenantId)).toMatchObject({ written: 3, finished: 1 })
    const all = await titles(tenantId)
    expect(all).toHaveLength(6)
    expect(all.every((row) => row.status === 'posted')).toBe(true)
    const view = await successor.get(tenantId, id)
    expect(view.isRight() && view.value.job.status).toBe('completed')
  })

  it('lets the relay role find tenants with work, and read nothing else', async () => {
    const tenantId = randomUUID()
    const customer = await party(tenantId, ['customer'])
    await start(jobsWith(movingClock()), tenantId, 'receivables', [
      `${customer};NF-1;01/09/2026;30/10/2026;10;BRL;1.01`,
    ])
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
