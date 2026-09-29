import type { DocumentState } from '@/domain/documents'
import type { ChunkKey, VectorHit } from '@/domain/ranking'

/** An event as the consumer received it, for the inbox. */
export interface ReceivedEvent {
  readonly tenantId: string
  readonly sourceModule: string
  readonly eventId: string
  readonly eventType: string
}

/** The record a file is attached to; the index never learns the file's name. */
export interface DocumentReference {
  readonly attachmentId: string
  readonly module: string
  readonly recordType: string
  readonly recordId: string
}

export interface DueDocument extends DocumentReference {
  readonly tenantId: string
  readonly contentType: string
  readonly attempts: number
  /** The lease this claim holds; a completion under another lease is refused. */
  readonly leaseUntil: Date
}

export interface SealedChunk {
  readonly ordinal: number
  readonly sealedText: Buffer
  readonly embedding: readonly number[]
  /** Its keyed lexemes, as `tsvector` text (Phase 75). */
  readonly lexemes: string
}

export interface IndexedDocument {
  readonly digest: string
  readonly indexVersion: string
  readonly wrappedKey: string
  readonly chunks: readonly SealedChunk[]
  readonly truncated: boolean
}

export type Recorded = 'recorded' | 'duplicate' | 'tombstoned'

export abstract class KnowledgeStore {
  /** A file became available: due for indexing, unless its tombstone says it ended. */
  abstract recordAvailable(
    event: ReceivedEvent,
    document: DocumentReference & { readonly contentType: string },
    now: Date,
  ): Promise<Recorded>
  /** A file ended: its chunks deleted, its key destroyed, its row kept as a tombstone. */
  abstract recordEnded(
    event: ReceivedEvent,
    document: DocumentReference,
    reason: string,
    now: Date,
  ): Promise<boolean>
  /** Documents embedded with another version become due again (ADR 0069). */
  abstract requeueStale(tenantId: string, indexVersion: string, now: Date): Promise<number>
  abstract claimDue(
    tenantId: string,
    now: Date,
    leaseMs: number,
    limit: number,
  ): Promise<DueDocument[]>
  /** Every chunk of a document in one transaction; false when the claim was lost. */
  abstract complete(document: DueDocument, indexed: IndexedDocument, now: Date): Promise<boolean>
  abstract settle(
    document: DueDocument,
    state: Extract<DocumentState, 'pending' | 'no-text' | 'failed'>,
    detail: string | null,
    dueAt: Date | null,
    now: Date,
  ): Promise<void>
}

export type FileContent =
  | { readonly kind: 'content'; readonly contentType: string; readonly bytes: Buffer }
  | { readonly kind: 'gone' }

/** A file's bytes, read as a reader of the owning module would read them. */
export abstract class FileSource {
  abstract read(tenantId: string, attachmentId: string): Promise<FileContent>
}

/** The text in a file, or null when it has none to give (an image, a scanned PDF). */
export abstract class TextExtractor {
  abstract extract(contentType: string, bytes: Buffer): Promise<string | null>
}

export abstract class Embedder {
  abstract readonly version: string
  abstract readonly dimensions: number
  /**
   * The cosine distance within which a chunk found only by its vector still counts as an
   * answer (Phase 75): each model spreads unrelated texts differently.
   */
  abstract readonly relevantDistance: number
  /**
   * The distance within which a confirmed example still votes for a suggestion (Phase 77):
   * the same product named twice sits much closer than any document to its question.
   */
  abstract readonly exampleDistance: number
  abstract embedDocuments(texts: readonly string[]): Promise<number[][]>
  abstract embedQuery(text: string): Promise<number[]>
}

/** Chunk text is sealed under a key of its document, which erasure destroys (ADR 0068). */
export abstract class Sealer {
  abstract newKey(tenantId: string, attachmentId: string): string
  abstract seal(
    wrappedKey: string,
    tenantId: string,
    attachmentId: string,
    ordinal: number,
    text: string,
  ): Buffer
  abstract open(
    wrappedKey: string,
    tenantId: string,
    attachmentId: string,
    ordinal: number,
    sealed: Buffer,
  ): string
}

/** The lexemes of each text, as PostgreSQL's Portuguese and English stemmers read it. */
export abstract class Lexicon {
  abstract lexemesOf(texts: readonly string[]): Promise<Map<string, number[]>[]>
}

/** A lexeme under a key of its tenant: equal words match within a tenant, and nowhere else. */
export abstract class LexemeHasher {
  abstract hash(tenantId: string, lexeme: string): string
}

/** What a search asks the index, already limited to the modules the caller reads. */
export interface CandidateQuery {
  readonly vector: readonly number[]
  /** Keyed `tsquery` text, or null when the question has no word to match. */
  readonly words: string | null
  readonly modules: readonly string[]
  readonly record?: Omit<DocumentReference, 'attachmentId'>
  readonly depth: number
}

export interface Candidates {
  readonly vector: readonly VectorHit[]
  readonly words: readonly ChunkKey[]
}

export interface StoredChunk extends DocumentReference {
  readonly ordinal: number
  readonly sealedText: Buffer
  readonly wrappedKey: string
  /** How many chunks its document has. */
  readonly of: number
}

export abstract class SearchStore {
  /** Both candidate lists, each filtered inside its own scan (ADR 0067). */
  abstract candidates(tenantId: string, query: CandidateQuery): Promise<Candidates>
  /** The chunks named, with their document's key, if still indexed and still readable. */
  abstract chunksOf(
    tenantId: string,
    keys: readonly ChunkKey[],
    modules: readonly string[],
  ): Promise<StoredChunk[]>
}

export interface SearchMetrics {
  searched(seconds: number, outcome: 'ok' | 'empty'): void
}

export interface Clock {
  now(): Date
}

export interface IndexMetrics {
  embedded(seconds: number): void
  settled(state: string): void
}
