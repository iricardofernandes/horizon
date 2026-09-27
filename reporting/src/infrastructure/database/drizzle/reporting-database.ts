import { and, count, desc, eq, lte, max, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import {
  type JournalScope,
  JournalStore,
  type RecordedSeal,
} from '@/application/ports/journal-store'
import { JOURNALED_SOURCES, type JournalEntry, type Source } from '@/domain/journal'
import * as schema from './schema'

export interface ReportingDatabaseOptions {
  readonly url: string
  readonly poolMax?: number
  readonly statementTimeoutMs?: number
}

type Database = ReturnType<typeof drizzle<typeof schema>>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface SourceState {
  readonly source: Source
  readonly events: number
  readonly latestOccurredAt: Date | null
  readonly watermark: Date | null
  readonly lastSeal: {
    readonly through: Date
    readonly producerCount: number
    readonly journalCount: number
    readonly outcome: string
    readonly receivedAt: Date
  } | null
}

function scopeOf(tx: Transaction, tenantId: string): JournalScope {
  return {
    async append(entry: JournalEntry) {
      const inserted = await tx
        .insert(schema.eventJournal)
        .values({
          sourceModule: entry.source,
          eventId: entry.eventId,
          tenantId,
          eventType: entry.eventType,
          eventVersion: entry.eventVersion,
          occurredAt: entry.occurredAt,
          traceId: entry.traceId,
          payload: entry.payload,
          arrival: entry.arrival,
        })
        .onConflictDoNothing()
        .returning({ eventId: schema.eventJournal.eventId })
      return inserted.length > 0
    },
    async countThrough(source: Source, through: Date) {
      const [row] = await tx
        .select({ value: count() })
        .from(schema.eventJournal)
        .where(
          and(
            eq(schema.eventJournal.sourceModule, source),
            lte(schema.eventJournal.occurredAt, through),
          ),
        )
      return row?.value ?? 0
    },
    async recordSeal(seal: RecordedSeal) {
      const inserted = await tx
        .insert(schema.sourceSeals)
        .values({
          id: seal.sealId,
          tenantId,
          sourceModule: seal.source,
          through: seal.through,
          producerCount: seal.producerCount,
          journalCount: seal.journalCount,
          outcome: seal.outcome,
          sealedAt: seal.sealedAt,
          receivedAt: seal.receivedAt,
        })
        .onConflictDoNothing()
        .returning({ id: schema.sourceSeals.id })
      return inserted.length > 0
    },
    async watermark(source: Source) {
      const [row] = await tx
        .select({ through: schema.sourceWatermarks.through })
        .from(schema.sourceWatermarks)
        .where(eq(schema.sourceWatermarks.sourceModule, source))
      return row?.through ?? null
    },
    async setWatermark(source: Source, through: Date, sealId: string) {
      await tx
        .insert(schema.sourceWatermarks)
        .values({ tenantId, sourceModule: source, through, sealId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [schema.sourceWatermarks.tenantId, schema.sourceWatermarks.sourceModule],
          set: { through, sealId, updatedAt: new Date() },
        })
    },
  }
}

/** Owns the connection; only tenant-bound scopes leave this module (ADR 0017). */
export class ReportingDatabase extends JournalStore {
  readonly #client: ReturnType<typeof postgres>
  readonly #db: Database

  constructor(options: ReportingDatabaseOptions) {
    super()
    this.#client = postgres(options.url, {
      max: options.poolMax ?? 10,
      connect_timeout: 5,
      connection: { statement_timeout: options.statementTimeoutMs ?? 5000 },
    })
    this.#db = drizzle(this.#client, { schema })
  }

  inTenant<T>(tenantId: string, work: (scope: JournalScope) => Promise<T>): Promise<T> {
    return this.#within(tenantId, (tx) => work(scopeOf(tx, tenantId)))
  }

  /** What the journal holds per source, and how far each is proven complete. */
  sources(tenantId: string): Promise<SourceState[]> {
    return this.#within(tenantId, async (tx) => {
      const held = await tx
        .select({
          source: schema.eventJournal.sourceModule,
          events: count(),
          latest: max(schema.eventJournal.occurredAt),
        })
        .from(schema.eventJournal)
        .groupBy(schema.eventJournal.sourceModule)
      const watermarks = await tx.select().from(schema.sourceWatermarks)
      const seals = await tx
        .selectDistinctOn([schema.sourceSeals.sourceModule])
        .from(schema.sourceSeals)
        .orderBy(schema.sourceSeals.sourceModule, desc(schema.sourceSeals.receivedAt))
      return JOURNALED_SOURCES.map((source) => {
        const journal = held.find((row) => row.source === source)
        const seal = seals.find((row) => row.sourceModule === source)
        return {
          source,
          events: journal?.events ?? 0,
          latestOccurredAt: journal?.latest ?? null,
          watermark: watermarks.find((row) => row.sourceModule === source)?.through ?? null,
          lastSeal: seal
            ? {
                through: seal.through,
                producerCount: seal.producerCount,
                journalCount: seal.journalCount,
                outcome: seal.outcome,
                receivedAt: seal.receivedAt,
              }
            : null,
        }
      })
    })
  }

  async ping(): Promise<void> {
    await this.#db.execute(sql`select 1`)
  }

  async close(): Promise<void> {
    await this.#client.end({ timeout: 5 })
  }

  #within<T>(tenantId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`)
      await tx.insert(schema.tenants).values({ id: tenantId }).onConflictDoNothing()
      return work(tx)
    })
  }
}
