import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { indexVersionOf } from '@/application/lexemes'
import { KnowledgeDatabase } from '@/infrastructure/database/knowledge-database'
import { HashEmbedder, TeiEmbedder } from '@/infrastructure/embedding/embedders'
import { harness } from './support/harness'

/**
 * The retrieval evaluation (Phase 75): a fixed bilingual corpus, indexed and searched as
 * the service does it. CI runs it with the deterministic embedder as a lexical gate;
 * `make eval-retrieval` runs it with multilingual-e5-small on TEI and stores the record.
 */
interface Corpus {
  documents: { id: string; module: string; recordType: string; language: string; text: string }[]
  questions: { text: string; expected: string; kind: 'lexical' | 'semantic' }[]
}

const K = 5
/** The gates the Phase 75 plan sets, per embedder. */
const GATES = {
  hash: { kind: 'lexical', recall: 0.9 },
  tei: { kind: 'all', recall: 0.8 },
} as const

const which = process.env.RETRIEVAL_EMBEDDER === 'tei' ? 'tei' : 'hash'
const embedder =
  which === 'tei'
    ? new TeiEmbedder(process.env.TEI_URL ?? 'http://127.0.0.1:8088')
    : new HashEmbedder()

let database: KnowledgeDatabase

beforeAll(() => {
  database = new KnowledgeDatabase({ url: process.env.DATABASE_URL ?? '' })
})

afterAll(async () => {
  await database?.close()
})

const recallOf = (ranks: readonly (number | null)[]) =>
  ranks.length ? ranks.filter((rank) => rank !== null && rank <= K).length / ranks.length : 0

describe(`retrieval with ${embedder.version}`, () => {
  it(`meets the gate on recall@${K}`, async () => {
    const corpus = JSON.parse(
      await readFile(join(__dirname, 'fixtures/retrieval-corpus.json'), 'utf8'),
    ) as Corpus
    const tenantId = randomUUID()
    const index = harness(database, embedder)
    const attachmentOf = new Map<string, string>()
    for (const document of corpus.documents) {
      const reference = await index.attach(tenantId, document, document.text)
      attachmentOf.set(reference.attachmentId, document.id)
    }
    await index.drain(tenantId)

    const caller = {
      tenantId,
      roles: ['parties', 'procurement', 'financial', 'sales', 'crm'].map((module) => ({
        module,
        role: 'viewer',
      })),
    }
    const results: { kind: string; rank: number | null }[] = []
    for (const question of corpus.questions) {
      const answer = await index.search.search(caller, { text: question.text, limit: K })
      const found = answer.data.map((citation) => attachmentOf.get(citation.attachmentId))
      const position = found.indexOf(question.expected)
      results.push({ kind: question.kind, rank: position === -1 ? null : position + 1 })
    }

    const ranksOf = (kind?: string) =>
      results.filter((result) => !kind || result.kind === kind).map((result) => result.rank)
    const recall = {
      lexical: recallOf(ranksOf('lexical')),
      semantic: recallOf(ranksOf('semantic')),
      all: recallOf(ranksOf()),
    }
    const reciprocal =
      results.reduce((sum, result) => sum + (result.rank ? 1 / result.rank : 0), 0) / results.length
    const gate = GATES[which]
    const passed = recall[gate.kind] >= gate.recall

    if (process.env.RETRIEVAL_RECORD) {
      const record = {
        phase: 75,
        kind: 'retrieval-evaluation',
        recordedAt: new Date().toISOString(),
        embedder: embedder.version,
        indexVersion: indexVersionOf(embedder),
        corpus: {
          documents: corpus.documents.length,
          questions: {
            lexical: ranksOf('lexical').length,
            semantic: ranksOf('semantic').length,
          },
        },
        k: K,
        recallAtK: Object.fromEntries(
          Object.entries(recall).map(([kind, value]) => [kind, Number(value.toFixed(3))]),
        ),
        meanReciprocalRank: Number(reciprocal.toFixed(3)),
        gate: { on: gate.kind, recallAtLeast: gate.recall },
        passed,
      }
      await mkdir(process.env.RETRIEVAL_RECORD, { recursive: true })
      await writeFile(
        join(
          process.env.RETRIEVAL_RECORD,
          `${record.recordedAt.slice(0, 10)}-phase75-retrieval-${which}.json`,
        ),
        `${JSON.stringify(record, null, 2)}\n`,
      )
    }
    process.stdout.write(
      `recall@${K} ${embedder.version}: ${JSON.stringify(recall)} mrr ${reciprocal.toFixed(3)}\n`,
    )
    expect(recall[gate.kind]).toBeGreaterThanOrEqual(gate.recall)
  }, 300_000)
})
