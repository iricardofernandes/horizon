import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Indexing } from '@/application/indexing'
import { type FileContent, FileSource } from '@/application/ports'
import { AesGcmSealer } from '@/infrastructure/cryptography/sealer'
import { KnowledgeDatabase, RelayDueScan } from '@/infrastructure/database/knowledge-database'
import { HashEmbedder } from '@/infrastructure/embedding/embedders'
import { FileTextExtractor } from '@/infrastructure/extraction/text-extractor'

/** Files as `files/` would serve them; anything not placed here is gone. */
class Files extends FileSource {
  readonly contents = new Map<string, FileContent>()
  async read(_tenant: string, attachmentId: string): Promise<FileContent> {
    return this.contents.get(attachmentId) ?? { kind: 'gone' }
  }
}

let database: KnowledgeDatabase
let administrator: postgres.Sql
let scan: RelayDueScan
const files = new Files()
const embedder = new HashEmbedder()
const sealer = new AesGcmSealer(randomBytes(32))
let clock = new Date('2026-09-29T12:00:00Z')
let indexing: Indexing

beforeAll(() => {
  database = new KnowledgeDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  scan = new RelayDueScan(process.env.DATABASE_RELAY_URL ?? '')
  indexing = new Indexing(
    database,
    files,
    new FileTextExtractor(),
    embedder,
    sealer,
    { now: () => clock },
    { embedded: () => undefined, settled: () => undefined },
    { leaseMs: 60_000, batch: 10 },
  )
})

afterAll(async () => {
  await Promise.all([database?.close(), administrator?.end(), scan?.close()])
})

const event = (tenantId: string, eventType: string) => ({
  tenantId,
  sourceModule: 'files',
  eventId: randomUUID(),
  eventType,
})

/** A text file attached to a purchase order, made available and indexed. */
async function indexed(tenantId: string, text: string) {
  const attachmentId = randomUUID()
  const reference = {
    attachmentId,
    module: 'procurement',
    recordType: 'purchase-order',
    recordId: randomUUID(),
  }
  files.contents.set(attachmentId, {
    kind: 'content',
    contentType: 'text/plain',
    bytes: Buffer.from(text),
  })
  await indexing.available(event(tenantId, 'files.attachment.available'), {
    ...reference,
    contentType: 'text/plain',
  })
  await indexing.indexDue(tenantId)
  return reference
}

const partitionOf = (tenantId: string) => `chunks_${tenantId.replaceAll('-', '')}`

describe('one partition per tenant (ADR 0067)', () => {
  it('plans a search in one tenant onto that tenant’s partition alone', async () => {
    const a = randomUUID()
    const b = randomUUID()
    await indexed(a, 'Pedido de café torrado para Campinas')
    await indexed(b, 'Contrato de manutenção predial em Sorocaba')
    const plan = await database.explainNearest(a, embedder.embed('café'), 5)
    expect(plan).toContain(partitionOf(a))
    expect(plan).not.toContain(partitionOf(b))
    const found = await database.nearest(a, embedder.embed('café torrado'), 5)
    expect(found.length).toBeGreaterThan(0)
    const [bOwn] = await database.nearest(b, embedder.embed('café torrado'), 5)
    expect(found.map((row) => row.attachmentId)).not.toContain(bOwn?.attachmentId)
  })

  it('gives each partition its own HNSW index, and the application no way around the parent', async () => {
    const tenantId = randomUUID()
    await indexed(tenantId, 'Nota de entrega 4711')
    const [index] = await administrator<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = ${partitionOf(tenantId)} and indexdef like '%hnsw%'`
    expect(index?.indexdef).toContain('vector_cosine_ops')
    const app = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
    try {
      // In its own tenant's transaction, as the application always runs, and still refused.
      await expect(
        app.begin(async (tx) => {
          await tx`select set_config('app.current_tenant', ${tenantId}, true)`
          await tx.unsafe(`select * from ${partitionOf(tenantId)}`)
        }),
      ).rejects.toThrow(/permission denied/)
    } finally {
      await app.end()
    }
  })

  it('shows one tenant nothing of another, even without naming a tenant in the query', async () => {
    const a = randomUUID()
    const b = randomUUID()
    const own = await indexed(a, 'Orçamento de embalagens')
    await indexed(b, 'Orçamento de embalagens')
    const seen = await database.inTenant(
      a,
      (tx) => tx<{ attachment_id: string }[]>`select attachment_id from chunks`,
    )
    expect(new Set(seen.map((row) => row.attachment_id))).toEqual(new Set([own.attachmentId]))
  })
})

describe('sealed, and gone with the file (ADR 0068)', () => {
  it('stores the text sealed, and opens it with the document key', async () => {
    const tenantId = randomUUID()
    const reference = await indexed(tenantId, 'Maria Silva assinou o contrato 88')
    const [raw] = await administrator<{ sealed_text: Buffer }[]>`
      select sealed_text from chunks where attachment_id = ${reference.attachmentId}`
    expect(raw?.sealed_text.toString('latin1')).not.toContain('Maria')
    const stored = await database.sealedChunks(tenantId, reference.attachmentId)
    const [chunk] = stored.chunks
    if (!stored.wrappedKey || !chunk) throw new Error('nothing indexed')
    expect(
      sealer.open(
        stored.wrappedKey,
        tenantId,
        reference.attachmentId,
        chunk.ordinal,
        chunk.sealedText,
      ),
    ).toBe('Maria Silva assinou o contrato 88')
  })

  it('removes an erased file’s vectors and key, and a replayed available does not bring them back', async () => {
    const tenantId = randomUUID()
    const reference = await indexed(tenantId, 'Proposta da Torrefação Aurora')
    await indexing.ended(event(tenantId, 'files.attachment.deleted'), reference, 'erased')
    const after = await database.sealedChunks(tenantId, reference.attachmentId)
    expect(after).toEqual({ wrappedKey: null, chunks: [] })
    const replayed = await indexing.available(event(tenantId, 'files.attachment.available'), {
      ...reference,
      contentType: 'text/plain',
    })
    expect(replayed).toBe('tombstoned')
    await indexing.indexDue(tenantId)
    expect((await database.sealedChunks(tenantId, reference.attachmentId)).chunks).toEqual([])
    expect((await database.status(tenantId)).documents).toEqual({ deleted: 1 })
  })

  it('never indexes a quarantined file, whatever arrives after', async () => {
    const tenantId = randomUUID()
    const reference = {
      attachmentId: randomUUID(),
      module: 'crm',
      recordType: 'opportunity',
      recordId: randomUUID(),
    }
    files.contents.set(reference.attachmentId, {
      kind: 'content',
      contentType: 'text/plain',
      bytes: Buffer.from('X5O!P%@AP'),
    })
    await indexing.ended(event(tenantId, 'files.attachment.quarantined'), reference, 'quarantined')
    expect(
      await indexing.available(event(tenantId, 'files.attachment.available'), {
        ...reference,
        contentType: 'text/plain',
      }),
    ).toBe('tombstoned')
    await indexing.indexDue(tenantId)
    expect((await database.status(tenantId)).chunks).toBe(0)
  })

  it('does nothing twice for a redelivered event', async () => {
    const tenantId = randomUUID()
    const once = event(tenantId, 'files.attachment.available')
    const reference = {
      attachmentId: randomUUID(),
      module: 'sales',
      recordType: 'service-order',
      recordId: randomUUID(),
      contentType: 'text/plain',
    }
    expect(await indexing.available(once, reference)).toBe('recorded')
    expect(await indexing.available(once, reference)).toBe('duplicate')
  })
})

describe('a worker that stops mid-document', () => {
  it('leaves each chunk written once when the next worker takes the lease over', async () => {
    const tenantId = randomUUID()
    const attachmentId = randomUUID()
    const words = Array.from({ length: 2000 }, (_, index) => `item${index}`).join(' ')
    files.contents.set(attachmentId, {
      kind: 'content',
      contentType: 'text/plain',
      bytes: Buffer.from(words),
    })
    await indexing.available(event(tenantId, 'files.attachment.available'), {
      attachmentId,
      module: 'financial',
      recordType: 'payable',
      recordId: randomUUID(),
      contentType: 'text/plain',
    })
    // The first worker claims the document and stops before writing anything.
    const [lost] = await database.claimDue(tenantId, clock, 60_000, 10)
    expect(lost?.attachmentId).toBe(attachmentId)
    expect(await indexing.indexDue(tenantId)).toBe(0)
    expect(await scan.tenantsWithWork(clock, embedder.version)).not.toContain(tenantId)
    // Past its lease, another worker takes it over and writes every chunk.
    clock = new Date(clock.getTime() + 61_000)
    expect(await scan.tenantsWithWork(clock, embedder.version)).toContain(tenantId)
    expect(await indexing.indexDue(tenantId)).toBe(1)
    // The first worker comes back: its completion is refused, nothing is written twice.
    if (!lost) throw new Error('no claim')
    expect(
      await database.complete(
        lost,
        {
          digest: '0'.repeat(64),
          indexVersion: 'x',
          wrappedKey: 'k',
          truncated: false,
          chunks: [],
        },
        clock,
      ),
    ).toBe(false)
    const [counts] = await administrator<{ total: number; distinct: number }[]>`
      select count(*)::int as total, count(distinct ordinal)::int as distinct
      from chunks where attachment_id = ${attachmentId}`
    expect(counts?.total).toBeGreaterThan(1)
    expect(counts?.total).toBe(counts?.distinct)
    const [document] = await administrator<{ chunks: number; attempts: number; state: string }[]>`
      select chunks, attempts, state from documents where attachment_id = ${attachmentId}`
    expect(document).toMatchObject({ state: 'indexed', attempts: 2, chunks: counts?.total })
  })

  it('re-embeds, in the background, what another model version wrote', async () => {
    const tenantId = randomUUID()
    const reference = await indexed(tenantId, 'Relatório de visita técnica')
    await administrator`update documents set index_version = 'old-v0' where attachment_id = ${reference.attachmentId}`
    expect(await scan.tenantsWithWork(clock, embedder.version)).toContain(tenantId)
    expect(await indexing.indexDue(tenantId)).toBe(1)
    const [document] = await administrator<{ index_version: string }[]>`
      select index_version from documents where attachment_id = ${reference.attachmentId}`
    expect(document?.index_version).toBe('hash-384-v1')
  })
})
