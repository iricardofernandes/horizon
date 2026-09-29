import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type PayableDetail, PayableSource } from '@/application/suggestion-ports'
import { ExampleIndex, NcmTableLoader, Suggestions } from '@/application/suggestions'
import { ExampleDatabase } from '@/infrastructure/database/example-database'
import { HashEmbedder } from '@/infrastructure/embedding/embedders'
import { readNcmTable } from '@/infrastructure/worker/ncm-table-worker'

class Payables extends PayableSource {
  readonly details = new Map<string, PayableDetail>()
  async read(_tenant: string, titleId: string) {
    return this.details.get(titleId) ?? null
  }
}

let examples: ExampleDatabase
let administrator: postgres.Sql
const embedder = new HashEmbedder()
const payables = new Payables()
const clock = { now: () => new Date() }
let index: ExampleIndex
let suggestions: Suggestions

beforeAll(() => {
  examples = new ExampleDatabase(process.env.DATABASE_URL ?? '')
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  index = new ExampleIndex(examples, payables, embedder, clock)
  suggestions = new Suggestions(
    examples,
    embedder,
    { suggested: () => undefined, decided: () => undefined },
    true,
  )
})

afterAll(async () => {
  await Promise.all([examples?.close(), administrator?.end()])
})

const event = (tenantId: string, eventType = 'catalog.item.created') => ({
  tenantId,
  sourceModule: eventType.split('.')[0] ?? 'x',
  eventId: randomUUID(),
  eventType,
})

async function item(tenantId: string, name: string, ncm: string | null) {
  const itemId = randomUUID()
  await index.itemCreated(event(tenantId), { itemId, name, sku: name.slice(0, 8), ncm })
  return itemId
}

describe('the confirmed history, one partition per tenant (ADR 0067)', () => {
  it('suggests what the workspace decided for a similar item, with the item as its reason', async () => {
    const tenantId = randomUUID()
    const known = await item(tenantId, 'Café torrado em grãos 500g', '09012100')
    await item(tenantId, 'Caneca de porcelana', '69120000')
    const answer = await suggestions.suggest(tenantId, 'ncm', 'Café torrado em grãos 1kg')
    expect(answer.available).toBe(true)
    expect(answer.suggestions[0]).toMatchObject({
      value: '09012100',
      reason: {
        examples: [{ sourceId: known, reference: 'Café torrado em grãos 500g (Café tor)' }],
      },
    })
  })

  it('plans a tenant’s neighbours onto its own partition, and never lets another tenant vote', async () => {
    const a = randomUUID()
    const b = randomUUID()
    await item(a, 'Parafuso sextavado', '73181500')
    const canary = await item(b, 'Chá mate canário 9f3e', '09030010')
    const plan = await examples.explainNearest(a, embedder.embed('chá mate'))
    expect(plan).toContain(`examples_${a.replaceAll('-', '')}`)
    expect(plan).not.toContain(`examples_${b.replaceAll('-', '')}`)
    const answer = await suggestions.suggest(a, 'ncm', 'Chá mate canário 9f3e')
    expect(answer.suggestions.map((suggestion) => suggestion.value)).not.toContain('09030010')
    expect(JSON.stringify(answer)).not.toContain(canary)
    const own = await suggestions.suggest(b, 'ncm', 'Chá mate canário 9f3e')
    expect(own.suggestions[0]?.value).toBe('09030010')
  })

  it('lets an item named first and classified later vote only once classified', async () => {
    const tenantId = randomUUID()
    const itemId = await item(tenantId, 'Filtro de papel para café', null)
    expect(
      (await suggestions.suggest(tenantId, 'ncm', 'Filtro de papel para café')).suggestions,
    ).toEqual([])
    await index.itemClassified(event(tenantId, 'catalog.item.classification-changed'), {
      itemId,
      ncm: '48239099',
    })
    expect(
      (await suggestions.suggest(tenantId, 'ncm', 'Filtro de papel')).suggestions[0]?.value,
    ).toBe('48239099')
  })

  it('handles each event once', async () => {
    const tenantId = randomUUID()
    const once = event(tenantId)
    const payload = { itemId: randomUUID(), name: 'Açúcar', sku: 'ACU', ncm: '17019900' }
    expect(await index.itemCreated(once, payload)).toBe(true)
    expect(await index.itemCreated(once, { ...payload, ncm: '00000000' })).toBe(false)
    expect((await suggestions.suggest(tenantId, 'ncm', 'Açúcar')).suggestions[0]?.value).toBe(
      '17019900',
    )
  })
})

describe('payable categories, and what leaves with a payable or its supplier (ADR 0068)', () => {
  it('counts the same supplier first, and forgets a reversed payable and an erased supplier', async () => {
    const tenantId = randomUUID()
    const aurora = randomUUID()
    const other = randomUUID()
    const post = async (
      partyId: string,
      partyName: string,
      description: string,
      categoryId: string,
    ) => {
      const titleId = randomUUID()
      payables.details.set(titleId, {
        partyId,
        partyName,
        description,
        documentNumber: `NF-${titleId.slice(0, 4)}`,
        categoryId,
      })
      await index.payablePosted(event(tenantId, 'financial.payable.posted'), { titleId })
      return titleId
    }
    const raw = randomUUID()
    const services = randomUUID()
    await post(aurora, 'Torrefação Aurora', 'Café verde para torra', raw)
    const reversed = await post(other, 'Oficina Central', 'Manutenção do torrador', services)
    const answer = await suggestions.suggest(
      tenantId,
      'payable-category',
      'Torrefação Aurora café verde',
      aurora,
    )
    expect(answer.suggestions[0]).toMatchObject({
      value: raw,
      reason: { examples: [{ sameParty: true }] },
    })

    await index.payableReversed(event(tenantId, 'financial.payable.reversed'), {
      titleId: reversed,
    })
    const [left] = await administrator<{ count: number }[]>`
      select count(*)::int as count from examples where tenant_id = ${tenantId} and source_id = ${reversed}`
    expect(left?.count).toBe(0)

    await index.partyErased(event(tenantId, 'parties.party.erased'), { partyId: aurora })
    const [erased] = await administrator<{ count: number }[]>`
      select count(*)::int as count from examples where tenant_id = ${tenantId} and party_id = ${aurora}`
    expect(erased?.count).toBe(0)
    expect(
      (
        await suggestions.suggest(
          tenantId,
          'payable-category',
          'Torrefação Aurora café verde',
          aurora,
        )
      ).suggestions,
    ).toEqual([])
  })
})

describe('the official NCM table (Phase 77)', () => {
  it('loads once for everyone, and votes for an item the workspace never classified', async () => {
    const table = await readNcmTable(join(__dirname, '../data/ncm-table.json.gz'))
    const sample = {
      act: table.act,
      codes: table.codes.filter(([code]) => code.startsWith('0901') || code.startsWith('9403')),
    }
    const loader = new NcmTableLoader(examples, embedder, clock)
    expect(await loader.load(sample)).toBe('loaded')
    expect(await loader.load(sample)).toBe('current')
    const answer = await suggestions.suggest(randomUUID(), 'ncm', 'Café torrado não descafeinado')
    expect(answer.suggestions[0]).toMatchObject({
      value: '09012100',
      reason: { examples: [], officialTable: true },
    })
    expect(answer.suggestions[0]?.description).toContain('Café torrado')
  })

  it('answers nothing while suggestions are off', async () => {
    const off = new Suggestions(
      examples,
      embedder,
      { suggested: () => undefined, decided: () => undefined },
      false,
    )
    expect(await off.suggest(randomUUID(), 'ncm', 'Café torrado')).toEqual({
      available: false,
      suggestions: [],
    })
  })
})
