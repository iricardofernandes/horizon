import { beforeEach, describe, expect, it } from 'vitest'
import type { CodeNeighbour, ExampleNeighbour, SuggestionKind } from '@/domain/suggestions'
import { Embedder, type ReceivedEvent } from './ports'
import {
  type CodeWrite,
  ExampleStore,
  type ExampleWrite,
  type PayableDetail,
  PayableSource,
  type TableState,
} from './suggestion-ports'
import { ExampleIndex, NcmTableLoader, Suggestions, TABLE_BATCH } from './suggestions'

class MemoryStore extends ExampleStore {
  readonly writes: { event: string; example: ExampleWrite }[] = []
  readonly relabels: { sourceId: string; label: string | null }[] = []
  readonly removed: string[] = []
  readonly erased: string[] = []
  examples: ExampleNeighbour[] = []
  codes: CodeNeighbour[] = []
  state: TableState | null = null
  inserted: CodeWrite[][] = []
  cleared = 0
  asked: { kind: SuggestionKind; codes: boolean }[] = []
  async putExample(event: ReceivedEvent, example: ExampleWrite) {
    this.writes.push({ event: event.eventId, example })
    return true
  }
  async relabel(_e: ReceivedEvent, _k: SuggestionKind, sourceId: string, label: string | null) {
    this.relabels.push({ sourceId, label })
    return true
  }
  async removeExample(_e: ReceivedEvent, _k: SuggestionKind, sourceId: string) {
    this.removed.push(sourceId)
    return true
  }
  async removeParty(_e: ReceivedEvent, partyId: string) {
    this.erased.push(partyId)
    return true
  }
  async nearestExamples(_t: string, kind: SuggestionKind) {
    this.asked.push({ kind, codes: false })
    return this.examples
  }
  async nearestCodes() {
    this.asked.push({ kind: 'ncm', codes: true })
    return this.codes
  }
  async tableState() {
    return this.state
  }
  async clearTable() {
    this.cleared += 1
  }
  async insertCodes(codes: readonly CodeWrite[]) {
    this.inserted.push([...codes])
  }
  async markTable(state: TableState) {
    this.state = state
  }
}

class WordEmbedder extends Embedder {
  readonly version = 'test-v1'
  readonly dimensions = 2
  readonly relevantDistance = 0.5
  readonly exampleDistance = 0.5
  readonly embedded: string[] = []
  async embedDocuments(texts: readonly string[]) {
    this.embedded.push(...texts)
    return texts.map(() => [1, 0])
  }
  async embedQuery() {
    return [1, 0]
  }
}

class Payables extends PayableSource {
  detail: PayableDetail | null = {
    partyId: 'p1',
    partyName: 'Torrefação Aurora',
    description: 'Café verde para torra',
    documentNumber: 'NF-12',
    categoryId: 'c-materia-prima',
  }
  async read() {
    return this.detail
  }
}

const event = (eventId = 'e1'): ReceivedEvent => ({
  tenantId: 't',
  sourceModule: 'catalog',
  eventId,
  eventType: 'x',
})

let store: MemoryStore
let embedder: WordEmbedder
let payables: Payables
let index: ExampleIndex

beforeEach(() => {
  store = new MemoryStore()
  embedder = new WordEmbedder()
  payables = new Payables()
  index = new ExampleIndex(store, payables, embedder, { now: () => new Date() })
})

describe('the confirmed history (Phase 77)', () => {
  it('keeps every item, embedding its name, labelled with its NCM or none yet', async () => {
    await index.itemCreated(event(), {
      itemId: 'i1',
      name: 'Café torrado 500g',
      sku: 'CAF-500',
      ncm: '09012100',
    })
    await index.itemCreated(event('e2'), { itemId: 'i2', name: 'Caneca', sku: 'CAN', ncm: null })
    expect(embedder.embedded).toEqual(['Café torrado 500g', 'Caneca'])
    expect(store.writes.map((write) => write.example)).toMatchObject([
      {
        kind: 'ncm',
        sourceId: 'i1',
        label: '09012100',
        reference: 'Café torrado 500g (CAF-500)',
        indexVersion: 'test-v1+lex-v1',
      },
      { kind: 'ncm', sourceId: 'i2', label: null },
    ])
    await index.itemClassified(event('e3'), { itemId: 'i2', ncm: '69120000' })
    expect(store.relabels).toEqual([{ sourceId: 'i2', label: '69120000' }])
  })

  it('reads a posted payable as a viewer, embeds its supplier and description, and keeps its party', async () => {
    await index.payablePosted(event(), { titleId: 'p-1' })
    expect(embedder.embedded).toEqual(['Torrefação Aurora Café verde para torra'])
    expect(store.writes[0]?.example).toMatchObject({
      kind: 'payable-category',
      sourceId: 'p-1',
      label: 'c-materia-prima',
      partyId: 'p1',
      reference: 'NF-12',
    })
  })

  it('skips a payable with no category, and one gone', async () => {
    payables.detail = { ...(payables.detail as PayableDetail), categoryId: null }
    expect(await index.payablePosted(event(), { titleId: 'p-1' })).toBe(false)
    payables.detail = null
    expect(await index.payablePosted(event(), { titleId: 'p-1' })).toBe(false)
    expect(store.writes).toEqual([])
  })

  it('falls back to the document number when a payable says nothing else', async () => {
    payables.detail = { ...(payables.detail as PayableDetail), partyName: null, description: null }
    await index.payablePosted(event(), { titleId: 'p-1' })
    expect(embedder.embedded).toEqual(['NF-12'])
  })

  it('takes out a reversed payable, and every example of an erased party', async () => {
    await index.payableReversed(event(), { titleId: 'p-1' })
    await index.partyErased(event('e2'), { partyId: 'p1' })
    expect(store.removed).toEqual(['p-1'])
    expect(store.erased).toEqual(['p1'])
  })
})

describe('the official table (Phase 77)', () => {
  const table = {
    act: 'Res Gecex 926/2026',
    codes: Array.from(
      { length: TABLE_BATCH + 5 },
      (_, n) => [String(n).padStart(8, '0'), `code ${n}`] as const,
    ),
  }

  it('embeds it in batches, then marks it loaded; a second load does nothing', async () => {
    const loader = new NcmTableLoader(store, embedder, { now: () => new Date() })
    expect(await loader.load(table)).toBe('loaded')
    expect(store.inserted.map((batch) => batch.length)).toEqual([TABLE_BATCH, 5])
    expect(store.state).toEqual({
      act: 'Res Gecex 926/2026',
      indexVersion: 'test-v1+lex-v1',
      codes: TABLE_BATCH + 5,
    })
    expect(await loader.load(table)).toBe('current')
    expect(store.cleared).toBe(1)
  })

  it('loads again, from scratch, for a new act or a half-done load', async () => {
    const loader = new NcmTableLoader(store, embedder, { now: () => new Date() })
    store.state = { act: 'old', indexVersion: 'test-v1+lex-v1', codes: TABLE_BATCH + 5 }
    expect(await loader.load(table)).toBe('loaded')
    store.state = { act: table.act, indexVersion: 'test-v1+lex-v1', codes: 3 }
    expect(await loader.load(table)).toBe('loaded')
    expect(store.cleared).toBe(2)
  })
})

describe('suggestions (Phase 77)', () => {
  const decided: string[] = []
  const metrics = {
    suggested: () => undefined,
    decided: (kind: SuggestionKind, decision: string) => decided.push(`${kind}:${decision}`),
  }

  it('answers nothing, and asks nothing, while suggestions are off', async () => {
    const off = new Suggestions(store, embedder, metrics, false)
    expect(await off.suggest('t', 'ncm', 'Café torrado')).toEqual({
      available: false,
      suggestions: [],
    })
    expect(store.asked).toEqual([])
  })

  it('asks the official table only for an NCM, and ranks the votes', async () => {
    store.examples = [
      { sourceId: 'i1', label: '09012100', reference: 'Café 500g', partyId: null, distance: 0.1 },
    ]
    store.codes = [{ code: '09012100', description: 'Café torrado', distance: 0.2 }]
    const on = new Suggestions(store, embedder, metrics, true)
    const ncm = await on.suggest('t', 'ncm', 'Café torrado 1kg')
    expect(ncm).toMatchObject({
      available: true,
      suggestions: [{ value: '09012100', description: 'Café torrado' }],
    })
    await on.suggest('t', 'payable-category', 'Aurora café', 'p1')
    expect(store.asked).toEqual([
      { kind: 'ncm', codes: false },
      { kind: 'ncm', codes: true },
      { kind: 'payable-category', codes: false },
    ])
  })

  it('only counts a decision', () => {
    new Suggestions(store, embedder, metrics, true).decide('ncm', 'accepted')
    expect(decided).toEqual(['ncm:accepted'])
  })
})
