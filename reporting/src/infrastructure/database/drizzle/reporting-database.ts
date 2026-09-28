import { createHash } from 'node:crypto'
import { context, trace } from '@opentelemetry/api'
import { and, count, desc, eq, lte, max, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { uuidv7 } from 'uuidv7'
import { type ConsistencyRun, ConsistencyStore } from '@/application/consistency'
import {
  type JournalScope,
  JournalStore,
  type RecordedSeal,
} from '@/application/ports/journal-store'
import {
  type AuditRecord,
  type CommandReceipt,
  type CommandScope,
  ReportingCommands,
  ReportReads,
  type SavedFilter,
  type StoredRun,
} from '@/application/ports/report-store'
import type { ReportData } from '@/application/report-data'
import { canonicalJson } from '@/core/audit/canonical-json'
import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { JOURNALED_SOURCES, type JournalEntry, type Source } from '@/domain/journal'
import type { CheckResult, ReportFilter, ReportName, RunOutcome } from '@/domain/reports'
import { type AuditFilter, type AuditPageView, readAuditPage } from './audit-reader'
import { exportScope } from './export-store'
import { movedAfter, readReport } from './report-reads'
import * as schema from './schema'
import type { Database, Transaction } from './transaction'
import { insertNotifications, SqlNotificationStore, SqlViewStore } from './user-state-store'

export interface ReportingDatabaseOptions {
  readonly url: string
  readonly poolMax?: number
  readonly statementTimeoutMs?: number
}

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

const GENESIS_HASH = '0'.repeat(64)

/** `hash = sha256(previous_hash || canonical_json(entry))`, as identity's chain (ADR 0025). */
export function auditHash(previousHash: string, entry: Record<string, unknown>): string {
  return createHash('sha256')
    .update(previousHash, 'utf8')
    .update(canonicalJson(entry), 'utf8')
    .digest('hex')
}

function mapRun(row: typeof schema.reconciliationRuns.$inferSelect): StoredRun {
  return {
    runId: row.id,
    report: row.report as ReportName,
    cutoff: row.cutoff,
    outcome: row.outcome as RunOutcome,
    checks: row.checks as CheckResult[],
    startedBy: row.startedBy,
    startedAt: row.startedAt,
  }
}

function mapFilter(row: typeof schema.savedFilters.$inferSelect): SavedFilter {
  return {
    filterId: row.id,
    report: row.report as ReportName,
    name: row.name,
    filter: row.filter as ReportFilter,
    ownerId: row.ownerId,
    shared: row.shared,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function commandScope(tx: Transaction, tenantId: string): CommandScope {
  const filters = schema.savedFilters
  return {
    ...exportScope(tx, tenantId),
    filters: {
      async insert(filter) {
        await tx.insert(filters).values({
          id: filter.filterId,
          tenantId,
          report: filter.report,
          name: filter.name,
          filter: filter.filter,
          ownerId: filter.ownerId,
          shared: filter.shared,
          createdAt: filter.createdAt,
          updatedAt: filter.updatedAt,
        })
      },
      async find(filterId) {
        const [row] = await tx.select().from(filters).where(eq(filters.id, filterId))
        return row ? mapFilter(row) : null
      },
      async update(filter) {
        await tx
          .update(filters)
          .set({
            name: filter.name,
            filter: filter.filter,
            shared: filter.shared,
            updatedAt: filter.updatedAt,
          })
          .where(eq(filters.id, filter.filterId))
      },
      async remove(filterId) {
        await tx.delete(filters).where(eq(filters.id, filterId))
      },
    },
    runs: {
      async insert(run) {
        await tx.insert(schema.reconciliationRuns).values({
          id: run.runId,
          tenantId,
          report: run.report,
          cutoff: run.cutoff,
          outcome: run.outcome,
          checks: run.checks,
          startedBy: run.startedBy,
          startedAt: run.startedAt,
        })
      },
    },
    notifications: {
      insert: (drafts, now) => insertNotifications(tx, tenantId, drafts, now),
    },
    audit: {
      async append(record: AuditRecord) {
        // A per-tenant transaction lock serializes chain appends, including the first link.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`reporting.audit:${tenantId}`}, 0))`,
        )
        const [last] = await tx
          .select({ sequence: schema.auditLog.sequence, hash: schema.auditLog.hash })
          .from(schema.auditLog)
          .orderBy(desc(schema.auditLog.sequence))
          .limit(1)
        const entry = {
          sequence: (last?.sequence ?? 0) + 1,
          tenantId,
          actor: record.actor,
          subjectType: record.subjectType,
          subjectId: record.subjectId,
          action: record.action,
          occurredAt: record.occurredAt,
          requestId: record.requestId,
          traceId: trace.getSpan(context.active())?.spanContext().traceId ?? null,
          details: JSON.parse(canonicalJson(record.details)) as Record<string, unknown>,
        }
        const previousHash = last?.hash ?? GENESIS_HASH
        await tx
          .insert(schema.auditLog)
          .values({ id: uuidv7(), ...entry, previousHash, hash: auditHash(previousHash, entry) })
      },
    },
  }
}

/** Carries a refused command out of its transaction, so nothing it wrote is kept. */
class Refused<E> extends Error {
  constructor(readonly failure: E) {
    super('command refused')
  }
}

/** Owns the connection; only tenant-bound scopes leave this module (ADR 0017). */
export class ReportingDatabase extends JournalStore {
  readonly #client: ReturnType<typeof postgres>
  readonly #db: Database
  readonly reports: ReportReads
  readonly commands: ReportingCommands
  readonly notifications: SqlNotificationStore
  readonly views: SqlViewStore
  readonly consistency: ConsistencyStore

  constructor(options: ReportingDatabaseOptions) {
    super()
    this.#client = postgres(options.url, {
      max: options.poolMax ?? 10,
      connect_timeout: 5,
      connection: { statement_timeout: options.statementTimeoutMs ?? 5000 },
    })
    this.#db = drizzle(this.#client, { schema })
    const within = <T>(tenantId: string, work: (tx: Transaction) => Promise<T>) =>
      this.#within(tenantId, work)
    this.notifications = new SqlNotificationStore(within)
    this.views = new SqlViewStore(within)
    this.consistency = new (class extends ConsistencyStore {
      record(tenantId: string, run: ConsistencyRun, requestId: string | null) {
        return within(tenantId, async (tx) => {
          await tx.insert(schema.consistencyRuns).values({
            id: run.runId,
            tenantId,
            trigger: run.trigger,
            outcome: run.outcome,
            checks: run.checks,
            pendingPostings: run.pendingPostings,
            startedBy: run.startedBy,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          })
          await commandScope(tx, tenantId).audit.append({
            actor: run.startedBy,
            action: 'consistency.run',
            subjectType: 'consistency-run',
            subjectId: run.runId,
            occurredAt: run.finishedAt,
            requestId,
            details: { trigger: run.trigger, outcome: run.outcome },
          })
        })
      }
      list(tenantId: string, limit: number) {
        return within(tenantId, async (tx) => {
          const runs = schema.consistencyRuns
          const rows = await tx.select().from(runs).orderBy(desc(runs.startedAt)).limit(limit)
          return rows.map(
            (row): ConsistencyRun => ({
              runId: row.id,
              trigger: row.trigger as ConsistencyRun['trigger'],
              outcome: row.outcome as ConsistencyRun['outcome'],
              checks: row.checks as ConsistencyRun['checks'],
              pendingPostings: row.pendingPostings,
              startedBy: row.startedBy,
              startedAt: row.startedAt,
              finishedAt: row.finishedAt,
            }),
          )
        })
      }
    })()
    this.reports = new (class extends ReportReads {
      report<N extends ReportName>(tenantId: string, name: N, cutoff: Date, filter: ReportFilter) {
        return within(tenantId, (tx) => readReport(tx, name, cutoff, filter)) as Promise<
          ReportData[N]
        >
      }
      movedAfter(tenantId: string, source: Source, cutoff: Date) {
        return within(tenantId, (tx) => movedAfter(tx, source, cutoff))
      }
      watermarks(tenantId: string) {
        return within(tenantId, async (tx) => {
          const rows = await tx.select().from(schema.sourceWatermarks)
          return new Map<Source, Date | null>(
            rows.map((row) => [row.sourceModule as Source, row.through]),
          )
        })
      }
      latestRun(tenantId: string, report: ReportName, cutoff: Date) {
        return within(tenantId, async (tx) => {
          const runs = schema.reconciliationRuns
          const [row] = await tx
            .select()
            .from(runs)
            .where(and(eq(runs.report, report), eq(runs.cutoff, cutoff)))
            .orderBy(desc(runs.startedAt))
            .limit(1)
          return row ? mapRun(row) : null
        })
      }
      listRuns(tenantId: string, report: ReportName, limit: number) {
        return within(tenantId, async (tx) => {
          const runs = schema.reconciliationRuns
          const found = await tx
            .select()
            .from(runs)
            .where(eq(runs.report, report))
            .orderBy(desc(runs.startedAt))
            .limit(limit)
          return found.map(mapRun)
        })
      }
      listFilters(tenantId: string, userId: string, report: ReportName | null) {
        return within(tenantId, async (tx) => {
          const filters = schema.savedFilters
          const visible = or(eq(filters.ownerId, userId), eq(filters.shared, true))
          const found = await tx
            .select()
            .from(filters)
            .where(report ? and(visible, eq(filters.report, report)) : visible)
            .orderBy(filters.report, filters.name)
          return found.map(mapFilter)
        })
      }
    })()
    this.commands = new (class extends ReportingCommands {
      inTenant<T>(tenantId: string, work: (scope: CommandScope) => Promise<T>) {
        return within(tenantId, (tx) => work(commandScope(tx, tenantId)))
      }
      async once<E, T>(
        tenantId: string,
        receipt: CommandReceipt,
        work: (scope: CommandScope) => Promise<Either<E, T>>,
      ): Promise<Either<E | ConflictError, T>> {
        try {
          return await within(tenantId, async (tx) => {
            const receipts = schema.commandReceipts
            // Claiming first makes a concurrent retry wait on this transaction, then see it.
            const claimed = await tx
              .insert(receipts)
              .values({ tenantId, ...receipt, response: {} })
              .onConflictDoNothing()
              .returning({ key: receipts.idempotencyKey })
            if (claimed.length === 0) {
              const [previous] = await tx
                .select()
                .from(receipts)
                .where(eq(receipts.idempotencyKey, receipt.idempotencyKey))
              if (
                previous?.command !== receipt.command ||
                previous.fingerprint !== receipt.fingerprint
              )
                return left<E | ConflictError, T>(
                  new ConflictError(
                    'this Idempotency-Key was already used for a different request',
                  ),
                )
              return right<E | ConflictError, T>(previous.response as T)
            }
            const outcome = await work(commandScope(tx, tenantId))
            if (outcome.isLeft()) throw new Refused(outcome.value)
            await tx
              .update(receipts)
              .set({ response: JSON.parse(JSON.stringify(outcome.value)) as object })
              .where(eq(receipts.idempotencyKey, receipt.idempotencyKey))
            return right<E | ConflictError, T>(outcome.value)
          })
        } catch (error) {
          if (error instanceof Refused) return left(error.failure as E)
          throw error
        }
      }
    })()
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

  /** A page of the tenant's audit log, with the chain's verdict on it (Phase 68). */
  auditPage(tenantId: string, filter: AuditFilter): Promise<AuditPageView> {
    return this.#within(tenantId, (tx) => readAuditPage(tx, filter))
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
