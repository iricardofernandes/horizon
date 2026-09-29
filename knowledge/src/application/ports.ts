import type { DocumentState } from '@/domain/documents'

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

export interface Clock {
  now(): Date
}

export interface IndexMetrics {
  embedded(seconds: number): void
  settled(state: string): void
}
