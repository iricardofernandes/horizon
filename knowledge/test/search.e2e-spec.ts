import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KnowledgeDatabase } from '@/infrastructure/database/knowledge-database'
import { HashEmbedder } from '@/infrastructure/embedding/embedders'
import { harness } from './support/harness'

let database: KnowledgeDatabase
let administrator: postgres.Sql
let index: ReturnType<typeof harness>

beforeAll(() => {
  database = new KnowledgeDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  index = harness(database, new HashEmbedder())
})

afterAll(async () => {
  await Promise.all([database?.close(), administrator?.end()])
})

const reader = (tenantId: string, ...modules: string[]) => ({
  tenantId,
  roles: modules.map((module) => ({ module, role: 'viewer' })),
})
const everything = (tenantId: string) =>
  reader(tenantId, 'parties', 'procurement', 'financial', 'sales', 'crm')

const party = { module: 'parties', recordType: 'party' }
const payable = { module: 'financial', recordType: 'payable' }

describe('a hybrid search, cited (Phase 75)', () => {
  it('finds by words and by meaning, and cites the attachment, record, position and text', async () => {
    const tenantId = randomUUID()
    const contract = await index.attach(
      tenantId,
      party,
      'Contrato de fornecimento de café torrado com entrega mensal em Campinas.',
    )
    await index.attach(tenantId, party, 'Relatório de visita técnica ao cliente de Sorocaba.')
    await index.drain(tenantId)
    const answer = await index.search.search(everything(tenantId), {
      text: 'fornecimento de café',
    })
    expect(answer.data[0]).toEqual({
      attachmentId: contract.attachmentId,
      record: { module: 'parties', recordType: 'party', recordId: contract.recordId },
      screen: '/app/registrations/parties',
      position: { chunk: 1, of: 1 },
      excerpt: 'Contrato de fornecimento de café torrado com entrega mensal em Campinas.',
      score: expect.any(Number),
      matchedBy: ['meaning', 'words'],
    })
  })

  it('stems Portuguese and folds accents: "contratos de manutencao" finds "contrato de manutenção"', async () => {
    const tenantId = randomUUID()
    const own = await index.attach(tenantId, party, 'Contrato de manutenção predial assinado.')
    await index.drain(tenantId)
    const [first] = (
      await index.search.search(everything(tenantId), { text: 'contratos manutencao' })
    ).data
    expect(first?.attachmentId).toBe(own.attachmentId)
    expect(first?.matchedBy).toContain('words')
  })

  it('stores no word of the text in the full-text index, only keyed hashes', async () => {
    const tenantId = randomUUID()
    const own = await index.attach(tenantId, party, 'Procuração para Joana Ribeiro assinar.')
    await index.drain(tenantId)
    const [row] = await administrator<{ lexemes: string }[]>`
      select lexemes::text as lexemes from chunks where attachment_id = ${own.attachmentId}`
    expect(row?.lexemes).toMatch(/^'[0-9a-f]{32}':\d/)
    expect(row?.lexemes).not.toMatch(/joan|ribeir|procura/i)
  })

  it('answers nothing to a question that shares nothing with the tenant’s files', async () => {
    const tenantId = randomUUID()
    await index.attach(tenantId, party, 'Contrato de fornecimento de café torrado.')
    await index.drain(tenantId)
    expect(
      (await index.search.search(everything(tenantId), { text: 'zqxw vvkj plomb' })).data,
    ).toEqual([])
  })

  it('searches one record’s attachments when asked to', async () => {
    const tenantId = randomUUID()
    const mine = await index.attach(tenantId, party, 'Contrato social da empresa, versão 3.')
    await index.attach(tenantId, party, 'Contrato social da empresa, versão 2.')
    await index.drain(tenantId)
    const answer = await index.search.search(everything(tenantId), {
      text: 'contrato social',
      record: { module: 'parties', recordType: 'party', recordId: mine.recordId },
    })
    expect(answer.data.map((citation) => citation.attachmentId)).toEqual([mine.attachmentId])
  })
})

describe('roles inside the scan (ADR 0067)', () => {
  it('finds a parties reader’s one chunk among two hundred financial ones', async () => {
    const tenantId = randomUUID()
    for (let number = 0; number < 200; number++)
      await index.attach(tenantId, payable, `Nota de serviço de limpeza da sede, número ${number}.`)
    const contract = await index.attach(tenantId, party, 'Contrato de limpeza da sede.')
    await index.drain(tenantId)
    const answer = await index.search.search(reader(tenantId, 'parties'), {
      text: 'limpeza da sede',
    })
    expect(answer).toMatchObject({ searched: ['parties'] })
    expect(answer.data.map((citation) => citation.attachmentId)).toEqual([contract.attachmentId])
    const financial = await index.search.search(reader(tenantId, 'financial'), {
      text: 'limpeza da sede',
      limit: 20,
    })
    expect(financial.data).toHaveLength(20)
    expect(financial.data.every((citation) => citation.record.module === 'financial')).toBe(true)
  })

  it('answers a reader without Financial a payable’s words exactly as it answers nonsense', async () => {
    const tenantId = randomUUID()
    await index.attach(tenantId, payable, 'Fatura de manutenção do gerador, pedido 7781.')
    await index.drain(tenantId)
    const partiesReader = reader(tenantId, 'parties', 'crm')
    const hidden = await index.search.search(partiesReader, {
      text: 'fatura manutenção gerador 7781',
    })
    const absent = await index.search.search(partiesReader, { text: 'zqxw vvkj plomb' })
    expect(hidden).toEqual(absent)
    expect(hidden).toEqual({ data: [], searched: ['parties', 'crm'] })
    const financial = await index.search.search(reader(tenantId, 'financial'), {
      text: 'fatura manutenção gerador 7781',
    })
    expect(financial.data).toHaveLength(1)
  })
})

describe('a canary in another tenant', () => {
  it('never appears, whatever is asked', async () => {
    const a = randomUUID()
    const b = randomUUID()
    const canaryText = 'Canário 9f3e: relatório ultrassecreto da fusão com a Aurora.'
    const canary = await index.attach(b, party, canaryText)
    await index.attach(a, party, 'Relatório da fusão com a Aurora, versão pública.')
    await index.drain(a)
    await index.drain(b)
    for (const text of [canaryText, 'canário ultrassecreto', 'relatório fusão Aurora', '9f3e']) {
      const answer = await index.search.search(everything(a), { text })
      expect(answer.data.map((citation) => citation.attachmentId)).not.toContain(
        canary.attachmentId,
      )
    }
    const own = await index.search.search(everything(b), { text: 'canário ultrassecreto' })
    expect(own.data[0]?.attachmentId).toBe(canary.attachmentId)
  })
})
