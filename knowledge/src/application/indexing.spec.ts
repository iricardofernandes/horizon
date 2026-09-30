import { beforeEach, describe, expect, it } from 'vitest'
import { fakeLexemes } from '../../test/support/lexicon'
import { Indexing } from './indexing'
import {
  type DueDocument,
  Embedder,
  type FileContent,
  FileSource,
  type IndexedDocument,
  KnowledgeStore,
  Sealer,
  TextExtractor,
} from './ports'

const due = (attempts = 1): DueDocument => ({
  tenantId: 't',
  attachmentId: 'a',
  module: 'procurement',
  recordType: 'purchase-order',
  recordId: 'r',
  contentType: 'text/plain',
  attempts,
  leaseUntil: new Date('2026-09-29T12:02:00Z'),
})

class FakeStore extends KnowledgeStore {
  claimed: DueDocument[] = []
  completed: IndexedDocument[] = []
  settled: { state: string; detail: string | null; dueAt: Date | null }[] = []
  accept = true
  async recordAvailable() {
    return 'recorded' as const
  }
  async recordEnded() {
    return true
  }
  async requeueStale() {
    return 0
  }
  async claimDue() {
    return this.claimed
  }
  async complete(_document: DueDocument, indexed: IndexedDocument) {
    this.completed.push(indexed)
    return this.accept
  }
  async settle(_d: DueDocument, state: string, detail: string | null, dueAt: Date | null) {
    this.settled.push({ state, detail, dueAt })
  }
}

class FakeFiles extends FileSource {
  answer: FileContent | Error = {
    kind: 'content',
    contentType: 'text/plain',
    bytes: Buffer.from('x'),
  }
  async read() {
    if (this.answer instanceof Error) throw this.answer
    return this.answer
  }
}

class FakeExtractor extends TextExtractor {
  text: string | null = 'Pedido de café torrado para a filial de Campinas'
  async extract() {
    return this.text
  }
}

class FakeEmbedder extends Embedder {
  readonly version = 'test-v1'
  readonly dimensions = 3
  readonly relevantDistance = 0.5
  readonly exampleDistance = 0.5
  async embedDocuments(texts: readonly string[]) {
    return texts.map(() => [1, 0, 0])
  }
  async embedQuery() {
    return [1, 0, 0]
  }
}

class FakeSealer extends Sealer {
  newKey() {
    return 'wrapped'
  }
  seal(_k: string, _t: string, _a: string, ordinal: number, text: string) {
    return Buffer.from(`${ordinal}:${text}`.split('').reverse().join(''))
  }
  open() {
    return ''
  }
}

let store: FakeStore
let files: FakeFiles
let extractor: FakeExtractor
let indexing: Indexing
const now = new Date('2026-09-29T12:00:00Z')

beforeEach(() => {
  store = new FakeStore()
  files = new FakeFiles()
  extractor = new FakeExtractor()
  indexing = new Indexing(
    store,
    files,
    extractor,
    new FakeEmbedder(),
    new FakeSealer(),
    fakeLexemes(),
    { now: () => now },
    { embedded: () => undefined, settled: () => undefined },
    { leaseMs: 60_000, batch: 5 },
  )
})

describe('indexing a due document', () => {
  it('writes every chunk, sealed and embedded, with the digest and the version', async () => {
    store.claimed = [due()]
    expect(await indexing.indexDue('t')).toBe(1)
    const [written] = store.completed
    expect(written).toMatchObject({
      indexVersion: 'test-v1+lex-v1+fake',
      wrappedKey: 'wrapped',
      truncated: false,
    })
    expect(written?.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(written?.chunks).toHaveLength(1)
    expect(written?.chunks[0]?.sealedText.toString()).not.toContain('café')
    // Its words are kept only as keyed hashes: folded, stemmed, hashed, with positions.
    const lexemes = written?.chunks[0]?.lexemes ?? ''
    expect(lexemes).toMatch(/^[0-9a-f]{16}:\d/)
    expect(lexemes).not.toMatch(/cafe|campinas/i)
  })

  it('settles a file with no text as no-text, not as a failure', async () => {
    store.claimed = [due()]
    extractor.text = null
    await indexing.indexDue('t')
    expect(store.settled).toEqual([{ state: 'no-text', detail: null, dueAt: null }])
    expect(store.completed).toEqual([])
  })

  it('retries a failure later, and gives up after the last attempt', async () => {
    store.claimed = [due(1)]
    files.answer = new Error('ECONNRESET')
    await indexing.indexDue('t')
    expect(store.settled[0]).toMatchObject({ state: 'pending', detail: 'Error' })
    expect(store.settled[0]?.dueAt?.getTime()).toBe(now.getTime() + 30_000)
    store.claimed = [due(5)]
    await indexing.indexDue('t')
    expect(store.settled[1]).toMatchObject({ state: 'failed', dueAt: null })
  })

  it('records the class of an error, never its message', async () => {
    store.claimed = [due()]
    files.answer = new TypeError('Maria Silva could not be read')
    await indexing.indexDue('t')
    expect(store.settled[0]?.detail).toBe('TypeError')
  })

  it('treats a file that is gone as a failure to retry, not as text', async () => {
    store.claimed = [due()]
    files.answer = { kind: 'gone' }
    await indexing.indexDue('t')
    expect(store.settled[0]).toMatchObject({
      state: 'pending',
      detail: 'the file is no longer available',
    })
  })
})

describe('what the events record', () => {
  it('passes an available file and an ended one to the store', async () => {
    const received = { tenantId: 't', sourceModule: 'files', eventId: 'e', eventType: 'x' }
    const reference = { attachmentId: 'a', module: 'crm', recordType: 'opportunity', recordId: 'r' }
    expect(await indexing.available(received, { ...reference, contentType: 'text/plain' })).toBe(
      'recorded',
    )
    expect(await indexing.ended(received, reference, 'erased')).toBe(true)
  })

  it('writes nothing it cannot account for: an embedder that loses chunks is a failure', async () => {
    store.claimed = [due()]
    const losing = new (class extends FakeEmbedder {
      override async embedDocuments() {
        return []
      }
    })()
    const strict = new Indexing(
      store,
      files,
      extractor,
      losing,
      new FakeSealer(),
      fakeLexemes(),
      { now: () => now },
      { embedded: () => undefined, settled: () => undefined },
      { leaseMs: 60_000, batch: 5 },
    )
    await strict.indexDue('t')
    expect(store.completed).toEqual([])
    expect(store.settled[0]).toMatchObject({ state: 'pending', detail: 'Error' })
  })

  it('counts nothing when the claim was lost to another worker', async () => {
    store.claimed = [due()]
    store.accept = false
    await indexing.indexDue('t')
    expect(store.completed).toHaveLength(1)
    expect(store.settled).toEqual([])
  })
})
