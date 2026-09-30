import { randomBytes, randomUUID } from 'node:crypto'
import { Indexing } from '@/application/indexing'
import { Lexemes } from '@/application/lexemes'
import { type Embedder, type FileContent, FileSource } from '@/application/ports'
import { Search } from '@/application/search'
import { MasterKeyring } from '@/infrastructure/cryptography/keyring'
import { HmacLexemeHasher } from '@/infrastructure/cryptography/lexeme-hasher'
import { AesGcmSealer } from '@/infrastructure/cryptography/sealer'
import type { KnowledgeDatabase } from '@/infrastructure/database/knowledge-database'
import { FileTextExtractor } from '@/infrastructure/extraction/text-extractor'

/** Files as `files/` would serve them; anything not placed here is gone. */
export class Files extends FileSource {
  readonly contents = new Map<string, FileContent>()
  async read(_tenant: string, attachmentId: string): Promise<FileContent> {
    return this.contents.get(attachmentId) ?? { kind: 'gone' }
  }
}

/** Indexing and search over one database, as the runtime composes them. */
export function harness(
  database: KnowledgeDatabase,
  embedder: Embedder,
  keys: {
    /** The master keys, current first (Phase 81); fresh ones when absent. */
    readonly masters?: readonly string[]
    readonly lexemeKey?: Buffer
    readonly files?: Files
  } = {},
) {
  const files = keys.files ?? new Files()
  const [current = randomBytes(32).toString('hex'), ...previous] = keys.masters ?? []
  const sealer = new AesGcmSealer(MasterKeyring.of(current, previous.join(',')))
  const lexemes = new Lexemes(
    database,
    new HmacLexemeHasher(keys.lexemeKey ?? Buffer.from(current, 'hex')),
  )
  const indexing = new Indexing(
    database,
    files,
    new FileTextExtractor(),
    embedder,
    sealer,
    lexemes,
    { now: () => new Date() },
    { embedded: () => undefined, settled: () => undefined },
    { leaseMs: 60_000, batch: 50 },
  )
  const search = new Search(database, embedder, lexemes, sealer, { searched: () => undefined })

  /** A text file attached to a record and made available; indexed by `drain`. */
  async function attach(
    tenantId: string,
    record: { module: string; recordType: string; recordId?: string },
    text: string,
  ) {
    const reference = {
      attachmentId: randomUUID(),
      module: record.module,
      recordType: record.recordType,
      recordId: record.recordId ?? randomUUID(),
    }
    files.contents.set(reference.attachmentId, {
      kind: 'content',
      contentType: 'text/plain',
      bytes: Buffer.from(text),
    })
    await indexing.available(
      {
        tenantId,
        sourceModule: 'files',
        eventId: randomUUID(),
        eventType: 'files.attachment.available',
      },
      { ...reference, contentType: 'text/plain' },
    )
    return reference
  }

  /** Every due document of a tenant indexed. */
  async function drain(tenantId: string) {
    while ((await indexing.indexDue(tenantId)) > 0);
  }

  return { files, indexing, search, sealer, attach, drain }
}
