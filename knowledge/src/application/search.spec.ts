import { beforeEach, describe, expect, it } from 'vitest'
import { fakeLexemes } from '../../test/support/lexicon'
import {
  type CandidateQuery,
  type Candidates,
  Embedder,
  Sealer,
  SearchStore,
  type StoredChunk,
} from './ports'
import { MAX_RESULTS, Search } from './search'

class FakeStore extends SearchStore {
  queries: CandidateQuery[] = []
  answer: Candidates = { vector: [], words: [] }
  stored: StoredChunk[] = []
  asked: { keys: number; modules: readonly string[] }[] = []
  async candidates(_tenant: string, query: CandidateQuery) {
    this.queries.push(query)
    return this.answer
  }
  async chunksOf(
    _tenant: string,
    keys: readonly { attachmentId: string }[],
    modules: readonly string[],
  ) {
    this.asked.push({ keys: keys.length, modules })
    return this.stored
  }
}

class FakeEmbedder extends Embedder {
  readonly version = 'test-v1'
  readonly dimensions = 3
  readonly relevantDistance = 0.5
  async embedDocuments(texts: readonly string[]) {
    return texts.map(() => [1, 0, 0])
  }
  async embedQuery() {
    return [0, 1, 0]
  }
}

/** Opens a chunk into its own text, stored reversed. */
class FakeSealer extends Sealer {
  newKey() {
    return 'k'
  }
  seal() {
    return Buffer.from('')
  }
  open(_k: string, _t: string, _a: string, _o: number, sealed: Buffer) {
    return sealed.toString().split('').reverse().join('')
  }
}

const chunk = (attachmentId: string, module: string, text: string, ordinal = 0): StoredChunk => ({
  attachmentId,
  ordinal,
  module,
  recordType: module === 'financial' ? 'payable' : 'party',
  recordId: `r-${attachmentId}`,
  sealedText: Buffer.from(text.split('').reverse().join('')),
  wrappedKey: 'k',
  of: 3,
})

let store: FakeStore
let search: Search
let outcomes: string[]

beforeEach(() => {
  store = new FakeStore()
  outcomes = []
  search = new Search(store, new FakeEmbedder(), fakeLexemes(), new FakeSealer(), {
    searched: (_seconds, outcome) => outcomes.push(outcome),
  })
})

const viewer = (...modules: string[]) => ({
  tenantId: 't',
  roles: modules.map((module) => ({ module, role: 'viewer' })),
})

describe('search (Phase 75)', () => {
  it('asks the index only for the modules the caller reads, and cites every result', async () => {
    store.answer = {
      vector: [{ attachmentId: 'f', ordinal: 1, distance: 0.2 }],
      words: [{ attachmentId: 'f', ordinal: 1 }],
    }
    store.stored = [chunk('f', 'financial', 'Nota fiscal de serviços de limpeza', 1)]
    const answer = await search.search(viewer('financial', 'crm'), { text: 'nota de limpeza' })
    expect(store.queries[0]).toMatchObject({ modules: ['financial', 'crm'], depth: 40 })
    expect(store.queries[0]?.words).toMatch(/^[0-9a-f]{16}( \| [0-9a-f]{16})*$/)
    expect(answer).toEqual({
      searched: ['financial', 'crm'],
      data: [
        {
          attachmentId: 'f',
          record: { module: 'financial', recordType: 'payable', recordId: 'r-f' },
          screen: '/app/finance/payables?open=r-f',
          position: { chunk: 2, of: 3 },
          excerpt: 'Nota fiscal de serviços de limpeza',
          score: expect.any(Number),
          matchedBy: ['meaning', 'words'],
        },
      ],
    })
    expect(outcomes).toEqual(['ok'])
  })

  it('answers nothing, without asking the index, when the caller reads no attaching module', async () => {
    const answer = await search.search(
      { tenantId: 't', roles: [{ module: 'identity', role: 'owner' }] },
      { text: 'contrato' },
    )
    expect(answer).toEqual({ searched: [], data: [] })
    expect(store.queries).toEqual([])
    expect(outcomes).toEqual(['empty'])
  })

  it('answers a key only in the modules its scopes reach', async () => {
    await search.search(
      { ...viewer('financial', 'parties'), scopes: ['knowledge:read', 'parties:read'] },
      { text: 'contrato' },
    )
    expect(store.queries[0]?.modules).toEqual(['parties'])
  })

  it('searches one record’s attachments only if the caller reads its module', async () => {
    const record = { module: 'financial', recordType: 'payable', recordId: 'p' }
    expect((await search.search(viewer('parties'), { text: 'nota', record })).data).toEqual([])
    expect(store.queries).toEqual([])
    await search.search(viewer('financial', 'parties'), { text: 'nota', record })
    expect(store.queries[0]).toMatchObject({ modules: ['financial'], record })
  })

  it('leaves out a ranked chunk that is gone by the time it is read', async () => {
    store.answer = {
      vector: [],
      words: [
        { attachmentId: 'gone', ordinal: 0 },
        { attachmentId: 'kept', ordinal: 0 },
      ],
    }
    store.stored = [chunk('kept', 'parties', 'Contrato social')]
    const answer = await search.search(viewer('parties'), { text: 'contrato' })
    expect(answer.data.map((citation) => citation.attachmentId)).toEqual(['kept'])
    expect(store.asked[0]).toEqual({ keys: 2, modules: ['parties'] })
  })

  it('reads nothing when nothing ranked, and never answers more than the maximum', async () => {
    expect((await search.search(viewer('parties'), { text: 'nada' })).data).toEqual([])
    expect(store.asked).toEqual([])
    store.answer = {
      vector: [],
      words: Array.from({ length: 80 }, (_, index) => ({ attachmentId: `a${index}`, ordinal: 0 })),
    }
    await search.search(viewer('parties'), { text: 'contrato', limit: 500 })
    expect(store.asked[0]?.keys).toBe(MAX_RESULTS)
  })
})
