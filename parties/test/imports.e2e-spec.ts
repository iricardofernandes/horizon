import { randomBytes, randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ImportJobs } from '@/application/imports/imports'
import { PartyImporter } from '@/application/imports/party-importer'
import type { RowKey } from '@/application/imports/ports'
import { RegisterPartyUseCase } from '@/application/use-cases/manage-parties'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { SqlImportStore } from '@/infrastructure/database/drizzle/import-store'
import { PartiesDatabase } from '@/infrastructure/database/drizzle/parties-database'
import { RelayImportScan } from '@/infrastructure/imports/import-worker'
import { RowWritingUnitOfWork, SealedImportRows } from '@/infrastructure/imports/party-rows'
import { TabularImportFiles } from '@/infrastructure/imports/tabular-files'

const secretBox = new AesGcmSecretBox()
let database: PartiesDatabase
let administrator: ReturnType<typeof postgres>
let relayUrl: string

beforeAll(() => {
  database = new PartiesDatabase({
    url: process.env.DATABASE_URL ?? '',
    privacy: { secretBox, blindIndexKey: randomBytes(32) },
  })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  relayUrl = (process.env.DATABASE_URL ?? '').replace(/\/\/[^:]+:[^@]+@/, '//horizon_relay:test@')
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end()])
})

/** A clock the test moves, so a lapsed lease does not need a real minute. */
function movingClock() {
  let now = new Date()
  return {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
  }
}

function jobsWith(
  clock: { now: () => Date },
  options: { crashAfter?: number; batchSize?: number } = {},
) {
  let writes = 0
  const importer = new PartyImporter(clock, (key: RowKey) => {
    writes += 1
    if (writes > (options.crashAfter ?? Number.POSITIVE_INFINITY)) throw new Error('killed')
    return new RowWritingUnitOfWork(database, key)
  })
  return new ImportJobs(
    new SqlImportStore(database, new SealedImportRows(secretBox), 'parties'),
    new TabularImportFiles(),
    [importer],
    clock,
    {
      maxRows: 10_000,
      maxBytes: 5 * 1024 * 1024,
      batchSize: options.batchSize ?? 3,
      leaseMs: 60_000,
      retentionMs: 72 * 3_600_000,
    },
  )
}

/** A valid CNPJ-shaped number per index; uniqueness is all the test needs. */
const cnpj = (index: number) => `${String(10_000_000 + index).padStart(8, '0')}000195`

function partiesFile(valid: number, invalidLines: readonly string[] = []): string {
  const header = 'Tipo;Razão Social;CNPJ;E-mail;Telefone;Endereço;Papéis'
  const rows = Array.from(
    { length: valid },
    (_, index) =>
      `PJ;Empresa ${index} LTDA;${cnpj(index)};contato${index}@example.com;1133330000;Rua ${index}, 10, São Paulo;cliente`,
  )
  return [header, ...rows, ...invalidLines].join('\r\n')
}

async function start(jobs: ImportJobs, tenantId: string, content: string, jobKey = 'file-1') {
  const uploaded = await jobs.upload({
    tenantId,
    actor: 'importer',
    kind: 'parties',
    jobKey,
    fileName: 'clientes.csv',
    format: 'csv',
    locale: 'pt-BR',
    bytes: new TextEncoder().encode(content),
  })
  if (uploaded.isLeft()) throw new Error(uploaded.value.message)
  const { id, mapping } = uploaded.value.view.job
  const mapped = await jobs.map(tenantId, id, mapping ?? {})
  if (mapped.isLeft()) throw new Error(mapped.value.message)
  await jobs.preview(tenantId, id)
  const confirmed = await jobs.confirm(tenantId, id)
  if (confirmed.isLeft()) throw new Error(confirmed.value.message)
  return id
}

async function partiesOf(tenantId: string): Promise<number> {
  const [row] = await administrator`select count(*)::int as count from parties
    where tenant_id = ${tenantId}`
  return Number(row?.count)
}

describe('importing parties', () => {
  it('writes the valid rows, reports every invalid one, and the counts add up', async () => {
    const tenantId = randomUUID()
    const jobs = jobsWith(movingClock())
    const id = await start(
      jobs,
      tenantId,
      partiesFile(5, [
        'PJ;X;123;a@b.co;1133330000;Rua A, 1;cliente',
        `PJ;Repetida LTDA;${cnpj(0)};r@example.com;1133330000;Rua B, 2, SP;cliente`,
        'PF;Ana Prospect;;;;;prospecto',
      ]),
    )
    const work = await jobs.runTenant(tenantId)
    expect(work).toMatchObject({ written: 6, finished: 1 })

    const view = await jobs.get(tenantId, id)
    if (view.isLeft()) throw new Error()
    expect(view.value.job.status).toBe('completed-with-failures')
    expect(view.value.progress).toEqual({
      total: 8,
      valid: 6,
      written: 6,
      failed: 2,
      remaining: 0,
      cancelled: 0,
    })
    expect(await partiesOf(tenantId)).toBe(6)

    const failures = await jobs.failures(tenantId, id)
    if (failures.isLeft()) throw new Error()
    const lines = new TextDecoder().decode(failures.value.bytes).trim().split('\r\n')
    expect(lines[0]).toBe('Tipo;Razão Social;CNPJ;E-mail;Telefone;Endereço;Papéis;linha;motivo')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain(';7;')
    expect(lines[2]).toContain(';8;repeats line 2 of this file')
  })

  it('registers a party exactly as the API would', async () => {
    const tenantId = randomUUID()
    const jobs = jobsWith(movingClock())
    await start(jobs, tenantId, partiesFile(1))
    await jobs.runTenant(tenantId)
    const [written] = await administrator`select id from parties where tenant_id = ${tenantId}`
    const imported = await database.findSnapshot(tenantId, String(written?.id))

    const direct = randomUUID()
    const registered = await new RegisterPartyUseCase(database, { now: () => new Date() }).execute({
      tenantId: direct,
      kind: 'organization',
      document: { type: 'cnpj', number: cnpj(0) },
      roles: ['customer'],
      legalName: 'Empresa 0 LTDA',
      email: 'contato0@example.com',
      phone: '1133330000',
      address: 'Rua 0, 10, São Paulo',
    })
    if (registered.isLeft()) throw registered.value
    const api = await database.findSnapshot(direct, registered.value.partyId)
    const comparable = (snapshot: typeof api) => ({
      ...snapshot,
      id: undefined,
      tenantId: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    })
    expect(comparable(imported)).toEqual(comparable(api))
    const events = await administrator`select event_type, payload from outbox
      where tenant_id = ${tenantId} order by created_at`
    expect(events.map((event) => event.event_type)).toEqual([
      'parties.party.registered',
      'parties.import.finished',
    ])
    expect(events[1]?.payload).toMatchObject({ status: 'completed', total: 1, written: 1 })
  })

  it('keeps the rows sealed, and destroys their key when the failures expire', async () => {
    const tenantId = randomUUID()
    const clock = movingClock()
    const jobs = jobsWith(clock)
    const id = await start(
      jobs,
      tenantId,
      partiesFile(2, ['PJ;Falha Secreta;1;a@b.co;1;x;cliente']),
    )
    const [sealed] = await administrator`select cells from import_rows where job_id = ${id}
      and line = 4`
    expect(String(sealed?.cells)).not.toContain('Secreta')
    await jobs.runTenant(tenantId)
    const cleared = await administrator`select line from import_rows
      where job_id = ${id} and cells is not null`
    expect(cleared.map((row) => row.line)).toEqual([4])

    clock.advance(72 * 3_600_000)
    expect(await jobs.runTenant(tenantId)).toMatchObject({ purged: 1 })
    const [job] = await administrator`select data_key, purged_at from import_jobs where id = ${id}`
    expect(job?.data_key).toBeNull()
    expect(job?.purged_at).not.toBeNull()
    const gone = await jobs.failures(tenantId, id)
    expect(gone.isLeft() && gone.value.kind).toBe('gone')
  })
})

describe('writing each row once', () => {
  it('finishes after a worker dies mid-import, with every row written once', async () => {
    const tenantId = randomUUID()
    const clock = movingClock()
    const dying = jobsWith(clock, { crashAfter: 7, batchSize: 4 })
    const id = await start(dying, tenantId, partiesFile(20))
    await expect(dying.runTenant(tenantId)).rejects.toThrow('killed')
    expect(await partiesOf(tenantId)).toBe(7)

    const successor = jobsWith(clock, { batchSize: 4 })
    expect(await successor.runTenant(tenantId)).toMatchObject({ written: 0 })
    clock.advance(61_000)
    expect(await successor.runTenant(tenantId)).toMatchObject({ written: 13, finished: 1 })
    expect(await partiesOf(tenantId)).toBe(20)
    const view = await successor.get(tenantId, id)
    expect(view.isRight() && view.value.job.status).toBe('completed')
    expect(view.isRight() && view.value.progress.written).toBe(20)
  })

  it('rolls back a write whose row was already taken', async () => {
    const tenantId = randomUUID()
    const jobs = jobsWith(movingClock())
    const id = await start(jobs, tenantId, partiesFile(1))
    await administrator`update import_rows set state = 'written' where job_id = ${id}`
    const register = new RegisterPartyUseCase(
      new RowWritingUnitOfWork(database, { jobId: id, line: 2 }),
      { now: () => new Date() },
    )
    await expect(
      register.execute({
        tenantId,
        kind: 'organization',
        document: { type: 'none' },
        roles: [],
        legalName: 'Nunca Gravada',
      }),
    ).rejects.toThrow('no longer waiting')
    expect(await partiesOf(tenantId)).toBe(0)
  })

  it('writes nothing new when the same file is imported again under the same key', async () => {
    const tenantId = randomUUID()
    const jobs = jobsWith(movingClock())
    const id = await start(jobs, tenantId, partiesFile(3))
    await jobs.runTenant(tenantId)
    const again = await jobs.upload({
      tenantId,
      actor: 'importer',
      kind: 'parties',
      jobKey: 'file-1',
      fileName: 'clientes.csv',
      format: 'csv',
      locale: 'pt-BR',
      bytes: new TextEncoder().encode(partiesFile(3)),
    })
    expect(again.isRight() && again.value).toMatchObject({ created: false, view: { job: { id } } })
    expect(await jobs.runTenant(tenantId)).toMatchObject({ written: 0 })
    expect(await partiesOf(tenantId)).toBe(3)
  })

  it('stops at a cancellation and writes nothing after it', async () => {
    const tenantId = randomUUID()
    const jobs = jobsWith(movingClock())
    const id = await start(jobs, tenantId, partiesFile(4))
    const cancelled = await jobs.cancel(tenantId, id)
    expect(cancelled.isRight() && cancelled.value.progress).toMatchObject({
      total: 4,
      cancelled: 4,
      remaining: 0,
    })
    await jobs.runTenant(tenantId)
    expect(await partiesOf(tenantId)).toBe(0)
    const finished = await administrator`select payload from outbox
      where tenant_id = ${tenantId} and event_type = 'parties.import.finished'`
    expect(finished.map((event) => event.payload)).toMatchObject([
      { status: 'cancelled', total: 4, cancelled: 4, written: 0 },
    ])
  })
})

describe('isolation', () => {
  it('shows a tenant only its own jobs and rows', async () => {
    const tenantId = randomUUID()
    const other = randomUUID()
    const jobs = jobsWith(movingClock())
    const id = await start(jobs, tenantId, partiesFile(1))
    expect((await jobs.get(other, id)).isLeft()).toBe(true)
    expect(await jobs.list(other)).toEqual([])
    const probe = (table: string) =>
      database.inTenantSql(other, (run) => run(sql`select * from ${sql.identifier(table)}`))
    expect(await probe('import_jobs')).toEqual([])
    expect(await probe('import_rows')).toEqual([])
  })

  it('lets the relay role find tenants with work, and nothing else', async () => {
    const tenantId = randomUUID()
    const jobs = jobsWith(movingClock())
    await start(jobs, tenantId, partiesFile(1))
    const scan = new RelayImportScan(relayUrl)
    try {
      expect(await scan.tenantsWithWork(new Date(), new Date(0))).toContain(tenantId)
    } finally {
      await scan.close()
    }
    const relay = postgres(relayUrl, { max: 1 })
    try {
      await expect(relay`select file_name from import_jobs`).rejects.toThrow(/permission denied/)
      await expect(relay`select cells from import_rows`).rejects.toThrow(/permission denied/)
    } finally {
      await relay.end()
    }
  })
})
