import postgres from 'postgres'
import {
  type CandidateQuery,
  type Candidates,
  type DocumentReference,
  type DueDocument,
  type IndexedDocument,
  KnowledgeStore,
  Lexicon,
  type ReceivedEvent,
  type Recorded,
  SearchStore,
  type StoredChunk,
} from '@/application/ports'
import type { DocumentState } from '@/domain/documents'
import type { ChunkKey } from '@/domain/ranking'

type Sql = postgres.Sql
type Tx = postgres.TransactionSql

export interface KnowledgeDatabaseOptions {
  readonly url: string
  readonly poolMax?: number
  readonly statementTimeoutMs?: number
}

/** pgvector's text form of a vector. */
export const vectorLiteral = (values: readonly number[]) =>
  `[${values.map((value) => (Number.isFinite(value) ? value : 0)).join(',')}]`

export interface Neighbour {
  readonly attachmentId: string
  readonly ordinal: number
  readonly module: string
  readonly recordType: string
  readonly recordId: string
  readonly distance: number
}

/** One stemmed lexeme of one text, as `lexemesOf` reads it from PostgreSQL. */
interface StemmedRow {
  readonly index: number
  readonly language: string
  readonly lexeme: string
  readonly positions: number[] | null
}

/**
 * Both parsers number words alike, so a position is one word, and a stop word has none in
 * that language: a lexeme is kept only at positions both languages found meaningful.
 */
function keptLexemes(count: number, rows: readonly StemmedRow[]): Map<string, number[]>[] {
  const spoken = Array.from({ length: count }, () => ({
    pt: new Set<number>(),
    en: new Set<number>(),
  }))
  for (const row of rows) {
    const words = spoken[row.index]?.[row.language === 'pt' ? 'pt' : 'en']
    for (const position of row.positions ?? []) words?.add(position)
  }
  const lexemes = Array.from({ length: count }, () => new Map<string, number[]>())
  for (const row of rows) {
    const words = spoken[row.index]
    const map = lexemes[row.index]
    const kept = (row.positions ?? []).filter(
      (position) => words?.pt.has(position) && words.en.has(position),
    )
    if (map && kept.length) map.set(row.lexeme, [...(map.get(row.lexeme) ?? []), ...kept])
  }
  return lexemes
}

/**
 * The index's store (ADR 0067). Every statement runs inside one tenant's transaction, with
 * `app.current_tenant` set, under forced RLS; chunks are read only through the partitioned
 * parent, and a search names its tenant so the planner prunes to that partition.
 */
export class KnowledgeDatabase extends KnowledgeStore implements Lexicon, SearchStore {
  readonly #sql: Sql

  constructor(options: KnowledgeDatabaseOptions) {
    super()
    this.#sql = postgres(options.url, {
      max: options.poolMax ?? 10,
      connect_timeout: 5,
      connection: { statement_timeout: options.statementTimeoutMs ?? 30_000 },
    })
  }

  inTenant<T>(tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return work(tx)
    }) as Promise<T>
  }

  private async claimInbox(tx: Tx, event: ReceivedEvent): Promise<boolean> {
    await tx`insert into tenants (id) values (${event.tenantId}) on conflict do nothing`
    const claimed = await tx`
      insert into inbox (source_module, event_id, event_type, tenant_id)
      values (${event.sourceModule}, ${event.eventId}, ${event.eventType}, ${event.tenantId})
      on conflict do nothing returning event_id`
    return claimed.length > 0
  }

  recordAvailable(
    event: ReceivedEvent,
    document: DocumentReference & { readonly contentType: string },
    now: Date,
  ): Promise<Recorded> {
    return this.inTenant(event.tenantId, async (tx) => {
      if (!(await this.claimInbox(tx, event))) return 'duplicate'
      const [existing] = await tx<{ state: string }[]>`
        select state from documents where attachment_id = ${document.attachmentId} for update`
      if (existing?.state === 'deleted') return 'tombstoned'
      await tx`
        insert into documents (tenant_id, attachment_id, module, record_type, record_id,
          content_type, state, attempts, due_at, created_at, updated_at)
        values (${event.tenantId}, ${document.attachmentId}, ${document.module},
          ${document.recordType}, ${document.recordId}, ${document.contentType}, 'pending', 0,
          ${now}, ${now}, ${now})
        on conflict (tenant_id, attachment_id) do update
          set content_type = excluded.content_type, state = 'pending', attempts = 0,
              due_at = excluded.due_at, last_error = null, updated_at = excluded.updated_at`
      return 'recorded'
    })
  }

  recordEnded(
    event: ReceivedEvent,
    document: DocumentReference,
    reason: string,
    now: Date,
  ): Promise<boolean> {
    return this.inTenant(event.tenantId, async (tx) => {
      if (!(await this.claimInbox(tx, event))) return false
      await tx`delete from chunks where tenant_id = ${event.tenantId}
        and attachment_id = ${document.attachmentId}`
      await tx`
        insert into documents (tenant_id, attachment_id, module, record_type, record_id,
          content_type, state, deletion_reason, created_at, updated_at, deleted_at)
        values (${event.tenantId}, ${document.attachmentId}, ${document.module},
          ${document.recordType}, ${document.recordId}, 'unknown', 'deleted', ${reason},
          ${now}, ${now}, ${now})
        on conflict (tenant_id, attachment_id) do update
          set state = 'deleted', deletion_reason = excluded.deletion_reason, wrapped_key = null,
              chunks = 0, due_at = null, updated_at = excluded.updated_at,
              deleted_at = coalesce(documents.deleted_at, excluded.deleted_at)`
      return true
    })
  }

  requeueStale(tenantId: string, indexVersion: string, now: Date): Promise<number> {
    return this.inTenant(tenantId, async (tx) => {
      const moved = await tx`
        update documents set state = 'pending', attempts = 0, due_at = ${now}, updated_at = ${now}
        where state = 'indexed' and index_version <> ${indexVersion} returning attachment_id`
      return moved.length
    })
  }

  claimDue(tenantId: string, now: Date, leaseMs: number, limit: number): Promise<DueDocument[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs)
    return this.inTenant(tenantId, async (tx) => {
      // `indexing` past its lease was claimed by a worker that stopped: take it over.
      const rows = await tx<
        {
          attachment_id: string
          module: string
          record_type: string
          record_id: string
          content_type: string
          attempts: number
        }[]
      >`
        update documents set state = 'indexing', attempts = attempts + 1, due_at = ${leaseUntil},
          updated_at = ${now}
        where (tenant_id, attachment_id) in (
          select tenant_id, attachment_id from documents
          where state in ('pending', 'indexing') and due_at <= ${now}
          order by due_at limit ${limit} for update skip locked)
        returning attachment_id, module, record_type, record_id, content_type, attempts`
      return rows.map((row) => ({
        tenantId,
        attachmentId: row.attachment_id,
        module: row.module,
        recordType: row.record_type,
        recordId: row.record_id,
        contentType: row.content_type,
        attempts: row.attempts,
        leaseUntil,
      }))
    })
  }

  complete(document: DueDocument, indexed: IndexedDocument, now: Date): Promise<boolean> {
    return this.inTenant(document.tenantId, async (tx) => {
      const [current] = await tx<{ state: string; due_at: Date | null }[]>`
        select state, due_at from documents where attachment_id = ${document.attachmentId}
        for update`
      // Deleted meanwhile, or taken over after the lease ran out: this work is not needed.
      if (
        current?.state !== 'indexing' ||
        current.due_at?.getTime() !== document.leaseUntil.getTime()
      )
        return false
      await tx`select ensure_chunk_partition(${document.tenantId})`
      await tx`delete from chunks where tenant_id = ${document.tenantId}
        and attachment_id = ${document.attachmentId}`
      for (const chunk of indexed.chunks)
        await tx`
          insert into chunks (tenant_id, attachment_id, ordinal, module, record_type, record_id,
            sealed_text, embedding, lexemes, index_version, created_at)
          values (${document.tenantId}, ${document.attachmentId}, ${chunk.ordinal},
            ${document.module}, ${document.recordType}, ${document.recordId}, ${chunk.sealedText},
            ${vectorLiteral(chunk.embedding)}::vector, ${chunk.lexemes}::tsvector,
            ${indexed.indexVersion}, ${now})`
      await tx`
        update documents set state = 'indexed', digest = ${indexed.digest},
          index_version = ${indexed.indexVersion}, wrapped_key = ${indexed.wrappedKey},
          chunks = ${indexed.chunks.length}, truncated = ${indexed.truncated}, due_at = null,
          last_error = null, indexed_at = ${now}, updated_at = ${now}
        where attachment_id = ${document.attachmentId}`
      return true
    })
  }

  settle(
    document: DueDocument,
    state: Extract<DocumentState, 'pending' | 'no-text' | 'failed'>,
    detail: string | null,
    dueAt: Date | null,
    now: Date,
  ): Promise<void> {
    return this.inTenant(document.tenantId, async (tx) => {
      await tx`
        update documents set state = ${state}, last_error = ${detail}, due_at = ${dueAt},
          updated_at = ${now}
        where attachment_id = ${document.attachmentId} and state = 'indexing'
          and due_at = ${document.leaseUntil}`
    })
  }

  /** The tenant's documents by state, and its chunks: what the status screen shows. */
  status(tenantId: string): Promise<{ documents: Record<string, number>; chunks: number }> {
    return this.inTenant(tenantId, async (tx) => {
      const states = await tx<{ state: string; count: number }[]>`
        select state, count(*)::int as count from documents group by state`
      const [chunks] = await tx<{ count: number }[]>`
        select count(*)::int as count from chunks where tenant_id = ${tenantId}`
      return {
        documents: Object.fromEntries(states.map((row) => [row.state, row.count])),
        chunks: chunks?.count ?? 0,
      }
    })
  }

  /**
   * The nearest chunks to a vector, in one tenant (ADR 0067). The tenant is named in the
   * query as well as in RLS, so the planner prunes to that tenant's partition and its index.
   */
  nearest(tenantId: string, vector: readonly number[], limit: number): Promise<Neighbour[]> {
    return this.inTenant(tenantId, async (tx) => {
      const rows = await tx<
        {
          attachment_id: string
          ordinal: number
          module: string
          record_type: string
          record_id: string
          distance: number
        }[]
      >`
        select attachment_id, ordinal, module, record_type, record_id,
          embedding <=> ${vectorLiteral(vector)}::vector as distance
        from chunks where tenant_id = ${tenantId}
        order by embedding <=> ${vectorLiteral(vector)}::vector limit ${limit}`
      return rows.map((row) => ({
        attachmentId: row.attachment_id,
        ordinal: row.ordinal,
        module: row.module,
        recordType: row.record_type,
        recordId: row.record_id,
        distance: Number(row.distance),
      }))
    })
  }

  /** The plan of that same query, for the proof that it reads one partition. */
  explainNearest(tenantId: string, vector: readonly number[], limit: number): Promise<string> {
    return this.inTenant(tenantId, async (tx) => {
      const rows = await tx.unsafe(
        `explain (costs off) select attachment_id from chunks where tenant_id = $1
         order by embedding <=> $2::vector limit $3`,
        [tenantId, vectorLiteral(vector), limit],
      )
      return rows.map((row) => String(Object.values(row)[0])).join('\n')
    })
  }

  /** A document's sealed chunks and its wrapped key, in order. */
  sealedChunks(
    tenantId: string,
    attachmentId: string,
  ): Promise<{ wrappedKey: string | null; chunks: { ordinal: number; sealedText: Buffer }[] }> {
    return this.inTenant(tenantId, async (tx) => {
      const [document] = await tx<{ wrapped_key: string | null }[]>`
        select wrapped_key from documents where attachment_id = ${attachmentId}`
      const chunks = await tx<{ ordinal: number; sealed_text: Buffer }[]>`
        select ordinal, sealed_text from chunks where tenant_id = ${tenantId}
          and attachment_id = ${attachmentId} order by ordinal`
      return {
        wrappedKey: document?.wrapped_key ?? null,
        chunks: chunks.map((row) => ({ ordinal: row.ordinal, sealedText: row.sealed_text })),
      }
    })
  }

  /**
   * Lexemes as PostgreSQL's Portuguese and English stemmers read each text (Phase 75). The
   * text is only passed through, never stored: the caller hashes what comes back. A word is
   * kept only where neither language holds it a stop word, so "de" or "the" matches nothing.
   */
  async lexemesOf(texts: readonly string[]): Promise<Map<string, number[]>[]> {
    if (!texts.length) return []
    const rows = await this.#sql<StemmedRow[]>`
      select (t.ordinal - 1)::int as index, l.language, l.lexeme, l.positions::int[] as positions
      from unnest(${this.#sql.array(texts as string[])}::text[]) with ordinality as t(body, ordinal)
      cross join lateral (
        select 'pt' as language, lexeme, positions from unnest(to_tsvector('portuguese', t.body))
        union all
        select 'en', lexeme, positions from unnest(to_tsvector('english', t.body))
      ) l`
    return keptLexemes(texts.length, rows)
  }

  /**
   * Both candidate lists of a search, in one tenant (ADR 0067). The modules the caller reads
   * filter each scan: the vector one with pgvector's iterative scan, which keeps walking the
   * index until enough readable chunks are found, and the full-text one through its GIN
   * index. Neither ever ranks a chunk the caller cannot read.
   */
  candidates(tenantId: string, query: CandidateQuery): Promise<Candidates> {
    return this.inTenant(tenantId, async (tx) => {
      await tx`select set_config('hnsw.iterative_scan', 'relaxed_order', true)`
      await tx`select set_config('hnsw.ef_search', ${String(Math.max(query.depth, 40))}, true)`
      const modules = tx.array(query.modules as string[])
      const record = query.record
      const inRecord = record
        ? tx`and module = ${record.module} and record_type = ${record.recordType}
             and record_id = ${record.recordId}`
        : tx``
      const vector = vectorLiteral(query.vector)
      const nearest = await tx<{ attachment_id: string; ordinal: number; distance: number }[]>`
        select attachment_id, ordinal, embedding <=> ${vector}::vector as distance
        from chunks where tenant_id = ${tenantId} and module = any(${modules}::text[]) ${inRecord}
        order by embedding <=> ${vector}::vector limit ${query.depth}`
      const words = query.words
        ? await tx<{ attachment_id: string; ordinal: number }[]>`
            select attachment_id, ordinal from chunks
            where tenant_id = ${tenantId} and module = any(${modules}::text[]) ${inRecord}
              and lexemes @@ ${query.words}::tsquery
            order by ts_rank_cd(lexemes, ${query.words}::tsquery) desc, attachment_id, ordinal
            limit ${query.depth}`
        : []
      return {
        vector: nearest.map((row) => ({
          attachmentId: row.attachment_id,
          ordinal: row.ordinal,
          distance: Number(row.distance),
        })),
        words: words.map((row) => ({ attachmentId: row.attachment_id, ordinal: row.ordinal })),
      }
    })
  }

  /** The chunks a search ranked, with their document's key, still indexed and readable. */
  chunksOf(
    tenantId: string,
    keys: readonly ChunkKey[],
    modules: readonly string[],
  ): Promise<StoredChunk[]> {
    if (!keys.length) return Promise.resolve([])
    return this.inTenant(tenantId, async (tx) => {
      const rows = await tx<
        {
          attachment_id: string
          ordinal: number
          module: string
          record_type: string
          record_id: string
          sealed_text: Buffer
          wrapped_key: string
          chunks: number
        }[]
      >`
        select c.attachment_id, c.ordinal, c.module, c.record_type, c.record_id, c.sealed_text,
          d.wrapped_key, d.chunks
        from chunks c
        join documents d on d.tenant_id = c.tenant_id and d.attachment_id = c.attachment_id
        where c.tenant_id = ${tenantId} and d.state = 'indexed'
          and c.module = any(${tx.array(modules as string[])}::text[])
          and (c.attachment_id, c.ordinal) in (
            select * from unnest(${tx.array(keys.map((key) => key.attachmentId))}::uuid[],
              ${tx.array(keys.map((key) => key.ordinal))}::int[]))`
      return rows.map((row) => ({
        attachmentId: row.attachment_id,
        ordinal: row.ordinal,
        module: row.module,
        recordType: row.record_type,
        recordId: row.record_id,
        sealedText: row.sealed_text,
        wrappedKey: row.wrapped_key,
        of: row.chunks,
      }))
    })
  }

  async ping(): Promise<void> {
    await this.#sql`select 1`
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 })
  }
}

/** Which tenants have work, and how old the oldest is, asked as the relay role. */
export class RelayDueScan {
  readonly #sql: Sql

  constructor(url: string) {
    this.#sql = postgres(url, { max: 1, connect_timeout: 5 })
  }

  async tenantsWithWork(now: Date, indexVersion: string): Promise<string[]> {
    const rows = await this.#sql<{ tenant_id: string }[]>`
      select distinct tenant_id from documents
      where (state in ('pending', 'indexing') and due_at <= ${now})
         or (state = 'indexed' and index_version <> ${indexVersion})`
    return rows.map((row) => row.tenant_id)
  }

  /** Seconds since the oldest due document became due: the index's lag. */
  async lagSeconds(now: Date): Promise<number> {
    const [row] = await this.#sql<{ oldest: Date | null }[]>`
      select min(due_at) as oldest from documents where state = 'pending' and due_at <= ${now}`
    return row?.oldest ? Math.max(0, (now.getTime() - row.oldest.getTime()) / 1000) : 0
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 })
  }
}
