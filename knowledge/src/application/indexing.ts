import { createHash } from 'node:crypto'
import { chunkText } from '@/domain/chunking'
import { afterFailure } from '@/domain/documents'
import { documentIndexVersionOf, type Lexemes } from './lexemes'
import type {
  Clock,
  DocumentReference,
  DueDocument,
  Embedder,
  FileSource,
  IndexMetrics,
  KnowledgeStore,
  ReceivedEvent,
  Recorded,
  Sealer,
  TextExtractor,
} from './ports'

export interface IndexingOptions {
  readonly leaseMs: number
  readonly batch: number
}

/** The error's class only: a message may quote the text of the file (ADR 0068). */
const kindOf = (error: unknown) => (error instanceof Error ? error.name : 'Error').slice(0, 200)

/**
 * The document index (Phase 74). Events record what is due; the worker reads each due file
 * as a reader of its module would, and writes all its chunks at once, sealed and embedded.
 * A deleted file's tombstone keeps it out for good.
 */
export class Indexing {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly files: FileSource,
    private readonly extractor: TextExtractor,
    private readonly embedder: Embedder,
    private readonly sealer: Sealer,
    private readonly lexemes: Lexemes,
    private readonly clock: Clock,
    private readonly metrics: IndexMetrics,
    private readonly options: IndexingOptions,
  ) {}

  available(
    event: ReceivedEvent,
    document: DocumentReference & { readonly contentType: string },
  ): Promise<Recorded> {
    return this.store.recordAvailable(event, document, this.clock.now())
  }

  ended(event: ReceivedEvent, document: DocumentReference, reason: string): Promise<boolean> {
    return this.store.recordEnded(event, document, reason, this.clock.now())
  }

  /** The version every document is indexed at, and re-indexed to when it changes. */
  get indexVersion(): string {
    return documentIndexVersionOf(this.embedder, this.lexemes)
  }

  /** One pass over a tenant: stale versions requeued, then a batch of due documents. */
  async indexDue(tenantId: string): Promise<number> {
    const now = this.clock.now()
    await this.store.requeueStale(tenantId, this.indexVersion, now)
    const due = await this.store.claimDue(tenantId, now, this.options.leaseMs, this.options.batch)
    for (const document of due) await this.indexOne(document)
    return due.length
  }

  private async indexOne(document: DueDocument): Promise<void> {
    try {
      const content = await this.files.read(document.tenantId, document.attachmentId)
      if (content.kind === 'gone') return this.fail(document, 'the file is no longer available')
      const text = await this.extractor.extract(content.contentType, content.bytes)
      const { chunks, truncated } = chunkText(text ?? '')
      if (!chunks.length) return this.settle(document, 'no-text', null, null)

      const started = performance.now()
      const vectors = await this.embedder.embedDocuments(chunks)
      this.metrics.embedded((performance.now() - started) / 1000)
      if (vectors.length !== chunks.length) throw new Error('the embedder lost chunks')
      const lexemes = await this.lexemes.ofChunks(document.tenantId, chunks)

      const wrappedKey = this.sealer.newKey(document.tenantId, document.attachmentId)
      const written = await this.store.complete(
        document,
        {
          digest: createHash('sha256').update(content.bytes).digest('hex'),
          indexVersion: this.indexVersion,
          wrappedKey,
          truncated,
          chunks: chunks.map((chunk, ordinal) => ({
            ordinal,
            sealedText: this.sealer.seal(
              wrappedKey,
              document.tenantId,
              document.attachmentId,
              ordinal,
              chunk,
            ),
            embedding: vectors[ordinal] ?? [],
            lexemes: lexemes[ordinal] ?? '',
          })),
        },
        this.clock.now(),
      )
      if (written) this.metrics.settled('indexed')
    } catch (error) {
      await this.fail(document, kindOf(error))
    }
  }

  private fail(document: DueDocument, detail: string): Promise<void> {
    const next = afterFailure(document.attempts)
    const dueAt = next.delayMs === null ? null : new Date(this.clock.now().getTime() + next.delayMs)
    return this.settle(document, next.state, detail, dueAt)
  }

  private async settle(
    document: DueDocument,
    state: 'pending' | 'no-text' | 'failed',
    detail: string | null,
    dueAt: Date | null,
  ): Promise<void> {
    await this.store.settle(document, state, detail, dueAt, this.clock.now())
    this.metrics.settled(state)
  }
}
