import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { masterKeyIdOf } from '@/infrastructure/cryptography/keyring'
import { KnowledgeDatabase } from '@/infrastructure/database/knowledge-database'
import { HashEmbedder } from '@/infrastructure/embedding/embedders'
import { Files, harness } from './support/harness'

let database: KnowledgeDatabase
let administrator: postgres.Sql

beforeAll(() => {
  database = new KnowledgeDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.all([database?.close(), administrator?.end()])
})

const key = () => randomBytes(32).toString('hex')
const party = { module: 'parties', recordType: 'party' }
const reader = (tenantId: string) => ({
  tenantId,
  roles: [{ module: 'parties', role: 'viewer' }],
})
const TEXT = 'Contrato de fornecimento de café torrado com entrega mensal em Campinas.'

async function onOldMasterKeys(tenantId: string, currentId: string) {
  const tenants = await database.tenantsOnOldMasterKeys(currentId)
  return tenants.find((tenant) => tenant.tenantId === tenantId)?.keys ?? 0
}

describe('rotating the knowledge master key (Phase 81)', () => {
  it('rewraps every document key, after which the old master key can go', async () => {
    const [old, current] = [key(), key()]
    const lexemeKey = randomBytes(32)
    const files = new Files()
    const tenantId = randomUUID()
    const before = harness(database, new HashEmbedder(), { masters: [old], lexemeKey, files })
    const document = await before.attach(tenantId, party, TEXT)
    await before.drain(tenantId)

    const during = harness(database, new HashEmbedder(), {
      masters: [current, old],
      lexemeKey,
      files,
    })
    expect(await onOldMasterKeys(tenantId, during.sealer.masterKeyId)).toBe(1)
    const moved = await database.rewrapKeys(
      tenantId,
      during.sealer.masterKeyId,
      (attachmentId, wrapped) => during.sealer.rewrap(wrapped, tenantId, attachmentId),
      50,
    )
    expect(moved).toBe(1)
    expect(await onOldMasterKeys(tenantId, during.sealer.masterKeyId)).toBe(0)
    const [row] = await administrator<{ master_key_id: string; wrapped_key: string }[]>`
      select master_key_id, wrapped_key from documents where attachment_id = ${document.attachmentId}`
    expect(row?.master_key_id).toBe(during.sealer.masterKeyId)
    expect(masterKeyIdOf(row?.wrapped_key ?? '')).toBe(during.sealer.masterKeyId)

    // The new master key alone reads every chunk, found by words and by meaning.
    const after = harness(database, new HashEmbedder(), { masters: [current], lexemeKey, files })
    const answer = await after.search.search(reader(tenantId), { text: 'fornecimento de café' })
    expect(answer.data[0]).toMatchObject({
      attachmentId: document.attachmentId,
      excerpt: TEXT,
      matchedBy: ['meaning', 'words'],
    })
  })

  it('re-indexes a tenant’s documents when the lexeme key changes, so words are found again', async () => {
    const master = key()
    const files = new Files()
    const tenantId = randomUUID()
    const first = harness(database, new HashEmbedder(), {
      masters: [master],
      lexemeKey: randomBytes(32),
      files,
    })
    const document = await first.attach(tenantId, party, TEXT)
    await first.drain(tenantId)

    const renewed = harness(database, new HashEmbedder(), {
      masters: [master],
      lexemeKey: randomBytes(32),
      files,
    })
    expect(renewed.indexing.indexVersion).not.toBe(first.indexing.indexVersion)
    await renewed.drain(tenantId)
    const answer = await renewed.search.search(reader(tenantId), { text: 'fornecimento de café' })
    expect(answer.data[0]).toMatchObject({
      attachmentId: document.attachmentId,
      matchedBy: ['meaning', 'words'],
    })
  })
})
