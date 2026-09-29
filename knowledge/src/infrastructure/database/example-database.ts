import postgres from 'postgres'
import type { ReceivedEvent } from '@/application/ports'
import {
  type CodeWrite,
  ExampleStore,
  type ExampleWrite,
  type TableState,
} from '@/application/suggestion-ports'
import type { CodeNeighbour, ExampleNeighbour, SuggestionKind } from '@/domain/suggestions'
import { vectorLiteral } from './knowledge-database'

type Tx = postgres.TransactionSql

/**
 * The confirmed history and the official NCM table (Phase 77). A tenant's examples live in
 * its own partition, reached only through the parent and named by tenant, so the planner
 * prunes to it (ADR 0067); the official table is public data, the same for everyone.
 */
export class ExampleDatabase extends ExampleStore {
  readonly #sql: postgres.Sql

  constructor(url: string, options: { readonly statementTimeoutMs?: number } = {}) {
    super()
    this.#sql = postgres(url, {
      max: 5,
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

  /** The event's inbox row, in the transaction of what it changes: false when it was seen. */
  private async claim(tx: Tx, event: ReceivedEvent): Promise<boolean> {
    await tx`insert into tenants (id) values (${event.tenantId}) on conflict do nothing`
    const claimed = await tx`
      insert into inbox (source_module, event_id, event_type, tenant_id)
      values (${event.sourceModule}, ${event.eventId}, ${event.eventType}, ${event.tenantId})
      on conflict do nothing returning event_id`
    return claimed.length > 0
  }

  putExample(event: ReceivedEvent, example: ExampleWrite, now: Date): Promise<boolean> {
    return this.inTenant(event.tenantId, async (tx) => {
      if (!(await this.claim(tx, event))) return false
      await tx`select ensure_example_partition(${event.tenantId})`
      await tx`
        insert into examples (tenant_id, kind, source_id, label, party_id, reference, embedding,
          index_version, updated_at)
        values (${event.tenantId}, ${example.kind}, ${example.sourceId}, ${example.label},
          ${example.partyId}, ${example.reference}, ${vectorLiteral(example.embedding)}::vector,
          ${example.indexVersion}, ${now})
        on conflict (tenant_id, kind, source_id) do update set label = excluded.label,
          party_id = excluded.party_id, reference = excluded.reference,
          embedding = excluded.embedding, index_version = excluded.index_version,
          updated_at = excluded.updated_at`
      return true
    })
  }

  relabel(
    event: ReceivedEvent,
    kind: SuggestionKind,
    sourceId: string,
    label: string | null,
    now: Date,
  ): Promise<boolean> {
    return this.inTenant(event.tenantId, async (tx) => {
      if (!(await this.claim(tx, event))) return false
      await tx`
        update examples set label = ${label}, updated_at = ${now}
        where tenant_id = ${event.tenantId} and kind = ${kind} and source_id = ${sourceId}`
      return true
    })
  }

  removeExample(event: ReceivedEvent, kind: SuggestionKind, sourceId: string): Promise<boolean> {
    return this.inTenant(event.tenantId, async (tx) => {
      if (!(await this.claim(tx, event))) return false
      await tx`delete from examples where tenant_id = ${event.tenantId} and kind = ${kind}
        and source_id = ${sourceId}`
      return true
    })
  }

  removeParty(event: ReceivedEvent, partyId: string): Promise<boolean> {
    return this.inTenant(event.tenantId, async (tx) => {
      if (!(await this.claim(tx, event))) return false
      await tx`delete from examples where tenant_id = ${event.tenantId} and party_id = ${partyId}`
      return true
    })
  }

  nearestExamples(
    tenantId: string,
    kind: SuggestionKind,
    vector: readonly number[],
    limit: number,
  ): Promise<ExampleNeighbour[]> {
    return this.inTenant(tenantId, async (tx) => {
      await tx`select set_config('hnsw.iterative_scan', 'relaxed_order', true)`
      const literal = vectorLiteral(vector)
      const rows = await tx<
        {
          source_id: string
          label: string
          reference: string
          party_id: string | null
          distance: number
        }[]
      >`
        select source_id, label, reference, party_id, embedding <=> ${literal}::vector as distance
        from examples
        where tenant_id = ${tenantId} and kind = ${kind} and label is not null
        order by embedding <=> ${literal}::vector limit ${limit}`
      return rows.map((row) => ({
        sourceId: row.source_id,
        label: row.label,
        reference: row.reference,
        partyId: row.party_id,
        distance: Number(row.distance),
      }))
    })
  }

  /** The plan of that same query, for the proof that it reads one partition. */
  explainNearest(tenantId: string, vector: readonly number[]): Promise<string> {
    return this.inTenant(tenantId, async (tx) => {
      const rows = await tx.unsafe(
        `explain (costs off) select source_id from examples where tenant_id = $1 and kind = 'ncm'
         order by embedding <=> $2::vector limit 10`,
        [tenantId, vectorLiteral(vector)],
      )
      return rows.map((row) => String(Object.values(row)[0])).join('\n')
    })
  }

  async nearestCodes(vector: readonly number[], limit: number): Promise<CodeNeighbour[]> {
    const literal = vectorLiteral(vector)
    const rows = await this.#sql<{ code: string; description: string; distance: number }[]>`
      select code, description, embedding <=> ${literal}::vector as distance
      from ncm_codes order by embedding <=> ${literal}::vector limit ${limit}`
    return rows.map((row) => ({ ...row, distance: Number(row.distance) }))
  }

  async tableState(): Promise<TableState | null> {
    const [row] = await this.#sql<{ act: string; index_version: string; codes: number }[]>`
      select act, index_version, codes from ncm_table_state`
    return row ? { act: row.act, indexVersion: row.index_version, codes: row.codes } : null
  }

  async clearTable(): Promise<void> {
    await this.#sql.begin(async (tx) => {
      await tx`delete from ncm_table_state`
      await tx`delete from ncm_codes`
    })
  }

  async insertCodes(codes: readonly CodeWrite[], indexVersion: string): Promise<void> {
    if (!codes.length) return
    await this.#sql`
      insert into ncm_codes ${this.#sql(
        codes.map((code) => ({
          code: code.code,
          description: code.description,
          embedding: vectorLiteral(code.embedding),
          index_version: indexVersion,
        })),
      )}`
  }

  async markTable(state: TableState, at: Date): Promise<void> {
    await this.#sql`
      insert into ncm_table_state (id, act, index_version, codes, loaded_at)
      values (true, ${state.act}, ${state.indexVersion}, ${state.codes}, ${at})
      on conflict (id) do update set act = excluded.act, index_version = excluded.index_version,
        codes = excluded.codes, loaded_at = excluded.loaded_at`
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 })
  }
}
