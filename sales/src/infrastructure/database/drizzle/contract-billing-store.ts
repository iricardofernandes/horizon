import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type {
  BilledEffectsRepository,
  BillingRunsRepository,
} from '@/domain/repositories/sales-repositories'
import {
  type BillingRun,
  REFUSAL_REASONS,
  RUN_OUTCOMES,
  type RunItem,
  type RunOutcome,
  SKIP_REASONS,
} from '@/domain/services/contract-billing'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

const REASONS: readonly string[] = [...SKIP_REASONS, ...REFUSAL_REASONS]

/** Billing runs of the tenant the transaction is scoped to (Phase 52). */
export function billingRunsRepository(tx: Transaction, tenantId: string): BillingRunsRepository {
  const items = schema.contractBillingRunItems
  const itemOf = (runId: string, contractId: string) =>
    and(eq(items.tenantId, tenantId), eq(items.runId, runId), eq(items.contractId, contractId))
  return {
    create: async (run) => {
      await tx.insert(schema.contractBillingRuns).values({
        id: run.id,
        tenantId,
        competence: run.competence,
        status: run.status,
        requestedBy: run.requestedBy,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      })
      if (run.items.length > 0)
        await tx
          .insert(items)
          .values(run.items.map((item) => ({ tenantId, runId: run.id, ...item })))
    },
    findById: (id) => findRun(tx, id),
    pending: async (runId, limit) => {
      const rows = await tx
        .select({ contractId: items.contractId })
        .from(items)
        .where(and(eq(items.runId, runId), eq(items.outcome, 'pending')))
        .orderBy(asc(items.contractId))
        .limit(limit)
      return rows.map((row) => row.contractId)
    },
    claim: async (runId, contractId) => {
      const [row] = await tx
        .select({ outcome: items.outcome })
        .from(items)
        .where(itemOf(runId, contractId))
        .for('update')
      return row?.outcome === 'pending'
    },
    decide: async (runId, contractId, decision, at) => {
      await tx
        .update(items)
        .set({
          outcome: decision.outcome,
          reason: decision.reason,
          billedPeriodId: decision.billedPeriodId,
          decidedAt: at,
        })
        .where(and(itemOf(runId, contractId), eq(items.outcome, 'pending')))
    },
    complete: async (runId, at) => {
      const [left] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(items)
        .where(and(eq(items.runId, runId), eq(items.outcome, 'pending')))
      if (Number(left?.count ?? 0) > 0) return false
      const closed = await tx
        .update(schema.contractBillingRuns)
        .set({ status: 'completed', finishedAt: at })
        .where(
          and(
            eq(schema.contractBillingRuns.tenantId, tenantId),
            eq(schema.contractBillingRuns.id, runId),
            eq(schema.contractBillingRuns.status, 'running'),
          ),
        )
        .returning({ id: schema.contractBillingRuns.id })
      return closed.length > 0
    },
  }
}

/** Receivables and NFS-e followed from their owners' events onto the billed periods. */
export function billedEffectsRepository(
  tx: Transaction,
  tenantId: string,
): BilledEffectsRepository {
  const periods = schema.contractBilledPeriods
  const lines = schema.contractBilledPeriodLines
  return {
    receivablePosted: async (billedPeriodId, titleId, at) => {
      const updated = await tx
        .update(periods)
        .set({ receivableTitleId: titleId, receivablePostedAt: at })
        .where(
          and(
            eq(periods.tenantId, tenantId),
            eq(periods.id, billedPeriodId),
            isNull(periods.receivablePostedAt),
          ),
        )
        .returning({ id: periods.id })
      return updated.length > 0
    },
    receivableReversed: async (titleId, at) => {
      const updated = await tx
        .update(periods)
        .set({ receivableReversedAt: at })
        .where(
          and(
            eq(periods.tenantId, tenantId),
            eq(periods.receivableTitleId, titleId),
            isNull(periods.receivableReversedAt),
          ),
        )
        .returning({ id: periods.id })
      return updated.length > 0
    },
    nfseObserved: async (entryId, documentId, outcome, at) => {
      // An older observation never overwrites a newer one: a cancellation stays cancelled.
      const updated = await tx
        .update(lines)
        .set({ nfseDocumentId: documentId, nfseStatus: outcome, nfseObservedAt: at })
        .where(
          and(
            eq(lines.tenantId, tenantId),
            eq(lines.entryId, entryId),
            or(isNull(lines.nfseObservedAt), lte(lines.nfseObservedAt, at)),
          ),
        )
        .returning({ entryId: lines.entryId })
      return updated.length > 0
    },
  }
}

export async function findRun(tx: Transaction, id: string): Promise<BillingRun | null> {
  const [run] = await tx
    .select()
    .from(schema.contractBillingRuns)
    .where(eq(schema.contractBillingRuns.id, id))
    .limit(1)
  if (!run) return null
  const items = await tx
    .select()
    .from(schema.contractBillingRunItems)
    .where(eq(schema.contractBillingRunItems.runId, id))
    .orderBy(asc(schema.contractBillingRunItems.contractId))
  return {
    id: run.id,
    competence: run.competence,
    status: run.status === 'completed' ? 'completed' : 'running',
    requestedBy: run.requestedBy,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    items: items.map(
      (item): RunItem => ({
        contractId: item.contractId,
        customerId: item.customerId,
        outcome: outcomeOf(item.outcome),
        reason: item.reason ? reasonOf(item.reason) : null,
        billedPeriodId: item.billedPeriodId,
        decidedAt: item.decidedAt,
      }),
    ),
  }
}

export async function listRuns(tx: Transaction, competence: string | null) {
  const rows = await tx
    .select({ id: schema.contractBillingRuns.id })
    .from(schema.contractBillingRuns)
    .where(competence ? eq(schema.contractBillingRuns.competence, competence) : undefined)
    .orderBy(desc(schema.contractBillingRuns.startedAt))
    .limit(50)
  const runs = await Promise.all(rows.map((row) => findRun(tx, row.id)))
  return runs.flatMap((run) => (run ? [run] : []))
}

/** What each billed period of a contract raised downstream, as its owners reported. */
export async function billedEffectsOf(tx: Transaction, contractId: string) {
  const periods = await tx
    .select({
      id: schema.contractBilledPeriods.id,
      receivableTitleId: schema.contractBilledPeriods.receivableTitleId,
      receivablePostedAt: schema.contractBilledPeriods.receivablePostedAt,
      receivableReversedAt: schema.contractBilledPeriods.receivableReversedAt,
    })
    .from(schema.contractBilledPeriods)
    .where(eq(schema.contractBilledPeriods.contractId, contractId))
  const lines =
    periods.length === 0
      ? []
      : await tx
          .select({
            entryId: schema.contractBilledPeriodLines.entryId,
            nfseDocumentId: schema.contractBilledPeriodLines.nfseDocumentId,
            nfseStatus: schema.contractBilledPeriodLines.nfseStatus,
          })
          .from(schema.contractBilledPeriodLines)
          .where(
            inArray(
              schema.contractBilledPeriodLines.billedPeriodId,
              periods.map((period) => period.id),
            ),
          )
  return {
    periods: new Map(periods.map((period) => [period.id, period])),
    lines: new Map(lines.map((line) => [line.entryId, line])),
  }
}

/**
 * Billed periods, not credited, older than `before`, still without a posted receivable or
 * without an authorized NFS-e on every line: what the billing alerts point at.
 */
export async function billingGaps(tx: Transaction, before: Date) {
  const periods = schema.contractBilledPeriods
  const lines = schema.contractBilledPeriodLines
  const unissued = sql<number>`(select count(*)::int from ${lines}
    where ${lines.billedPeriodId} = ${periods.id}
      and ${lines.nfseStatus} is distinct from ${'authorized'})`
  const rows = await tx
    .select({
      billedPeriodId: periods.id,
      contractId: periods.contractId,
      competence: periods.competence,
      billedAt: periods.billedAt,
      receivablePosted: sql<boolean>`${periods.receivablePostedAt} is not null`,
      linesWithoutNfse: unissued,
    })
    .from(periods)
    .where(
      and(
        isNull(periods.creditReasonCode),
        lt(periods.billedAt, before),
        sql`(${periods.receivablePostedAt} is null or ${unissued} > 0)`,
      ),
    )
    .orderBy(asc(periods.billedAt))
    .limit(100)
  return rows.map((row) => ({
    ...row,
    receivablePosted: Boolean(row.receivablePosted),
    linesWithoutNfse: Number(row.linesWithoutNfse),
  }))
}

function outcomeOf(value: string): RunOutcome {
  if (!(RUN_OUTCOMES as readonly string[]).includes(value))
    throw new Error('Invalid persisted billing run outcome')
  return value as RunOutcome
}

function reasonOf(value: string): NonNullable<RunItem['reason']> {
  if (!REASONS.includes(value)) throw new Error('Invalid persisted billing run reason')
  return value as NonNullable<RunItem['reason']>
}
