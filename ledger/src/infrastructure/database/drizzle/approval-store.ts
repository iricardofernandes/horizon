import { desc, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import {
  MANUAL_ENTRY_STATUSES,
  ManualEntry,
  type ManualEntryStatus,
} from '@/domain/entities/manual-entry'
import type {
  EntryApprovalPoliciesRepository,
  ManualEntriesRepository,
} from '@/domain/repositories/ledger-repositories'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type Row = typeof schema.manualEntries.$inferSelect

function statusOf(value: string): ManualEntryStatus {
  if (!(MANUAL_ENTRY_STATUSES as readonly string[]).includes(value))
    throw new Error('Invalid persisted manual entry status')
  return value as ManualEntryStatus
}

function toEntry(row: Row): ManualEntry {
  return ManualEntry.rehydrate(
    {
      tenantId: row.tenantId,
      terms: {
        reference: row.reference,
        postedOn: row.postedOn,
        currency: row.currency,
        memo: row.memo,
        lines: row.lines,
      },
      total: row.total,
      status: statusOf(row.status),
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt,
      decidedBy: row.decidedBy,
      decidedFor: row.decidedFor,
      decidedAt: row.decidedAt,
      decisionReason: row.decisionReason,
      transactionId: row.transactionId,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function rowOf(entry: ManualEntry) {
  const { terms, ...snapshot } = entry.toSnapshot()
  return { ...snapshot, ...terms, lines: [...terms.lines] }
}

export function manualEntriesRepository(
  tx: Transaction,
  tenantId: string,
): ManualEntriesRepository {
  const table = schema.manualEntries
  return {
    findForUpdate: async (id) => {
      const [row] = await tx.select().from(table).where(eq(table.id, id)).for('update')
      return row ? toEntry(row) : null
    },
    create: async (entry) => {
      const row = rowOf(entry)
      if (row.tenantId !== tenantId) throw new Error('Manual entry tenant does not match')
      await tx.insert(table).values(row)
    },
    save: async (entry) => {
      const row = rowOf(entry)
      await tx
        .update(table)
        .set({
          status: row.status,
          decidedBy: row.decidedBy,
          decidedFor: row.decidedFor,
          decidedAt: row.decidedAt,
          decisionReason: row.decisionReason,
          transactionId: row.transactionId,
          updatedAt: row.updatedAt,
        })
        .where(eq(table.id, row.id))
    },
  }
}

export function entryPoliciesRepository(
  tx: Transaction,
  tenantId: string,
): EntryApprovalPoliciesRepository {
  const table = schema.entryApprovalPolicies
  return {
    find: async (currency) => {
      const [row] = await tx.select().from(table).where(eq(table.currency, currency)).limit(1)
      return row
        ? { currency: row.currency, threshold: row.threshold, updatedAt: row.updatedAt }
        : null
    },
    save: async (policy) => {
      await tx
        .insert(table)
        .values({ tenantId, ...policy })
        .onConflictDoUpdate({
          target: [table.tenantId, table.currency],
          set: { threshold: policy.threshold, updatedAt: policy.updatedAt },
        })
    },
  }
}

/** Manual entries, newest first, for the approval queue. */
export async function listManualEntries(tx: Transaction, status: ManualEntryStatus | null) {
  const table = schema.manualEntries
  const rows = await tx
    .select()
    .from(table)
    .where(status ? eq(table.status, status) : undefined)
    .orderBy(desc(table.requestedAt))
    .limit(200)
  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    postedOn: row.postedOn,
    currency: row.currency,
    memo: row.memo,
    lines: row.lines,
    total: row.total.toString(),
    status: row.status,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedFor: row.decidedFor,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    transactionId: row.transactionId,
  }))
}

export async function listEntryPolicies(tx: Transaction) {
  const rows = await tx.select().from(schema.entryApprovalPolicies)
  return rows.map((row) => ({
    currency: row.currency,
    threshold: row.threshold.toString(),
    updatedAt: row.updatedAt.toISOString(),
  }))
}
