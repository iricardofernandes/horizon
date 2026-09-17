import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import {
  RECONCILIATION_KINDS,
  RECONCILIATION_ORIGINS,
  Reconciliation,
  type ReconciliationKind,
  type ReconciliationOrigin,
} from '@/domain/entities/reconciliation'
import type { StatementLine } from '@/domain/entities/statement-line'
import type {
  ClosuresRepository,
  ReconciliationsRepository,
  StatementsRepository,
} from '@/domain/repositories/treasury-repositories'
import { Reason } from '@/domain/value-objects/treasury-values'
import * as schema from './schema'
import { mapEntry, publishAll, restored, type Transaction } from './treasury-store'

function mapLine(row: typeof schema.statementLines.$inferSelect): StatementLine {
  return {
    id: row.id,
    tenantId: row.tenantId,
    accountId: row.accountId,
    importId: row.importId,
    fingerprint: row.fingerprint,
    postedOn: row.postedOn,
    amount: row.amount,
    currency: row.currency,
    bankReference: row.bankReference,
    documentId: row.documentId,
    description: row.description,
    counterparty: row.counterparty,
    raw: row.raw,
  }
}

/** Unsigned amounts applied to each item by reconciliations still in force. */
async function appliedTo(
  tx: Transaction,
  column: 'statement_line_id' | 'entry_id',
  ids: readonly string[],
): Promise<Map<string, bigint>> {
  if (ids.length === 0) return new Map()
  const rows = (await tx.execute(sql`
    select i.${sql.raw(column)} as id, coalesce(sum(abs(i.applied)), 0)::text as applied
    from reconciliation_items i
    join reconciliations r on r.tenant_id = i.tenant_id and r.id = i.reconciliation_id
    where r.status = 'active' and i.${sql.raw(column)} in ${sql`(${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`}
    group by i.${sql.raw(column)}`)) as unknown as { id: string; applied: string }[]
  return new Map(rows.map((row) => [row.id, BigInt(row.applied)]))
}

export function statementsRepository(tx: Transaction, tenantId: string): StatementsRepository {
  return {
    findImportByHash: async (accountId, fileHash) => {
      const [row] = await tx
        .select()
        .from(schema.statementImports)
        .where(
          and(
            eq(schema.statementImports.accountId, accountId),
            eq(schema.statementImports.fileHash, fileHash),
          ),
        )
        .limit(1)
      if (!row) return null
      return {
        ...row,
        format: row.format === 'ofx' ? 'ofx' : 'csv',
        closingBalance:
          row.closingBalance !== null && row.closingBalanceOn
            ? { amount: row.closingBalance, on: row.closingBalanceOn }
            : null,
      }
    },
    knownFingerprints: async (accountId, fingerprints) => {
      if (fingerprints.length === 0) return new Set()
      const rows = await tx
        .select({ fingerprint: schema.statementLines.fingerprint })
        .from(schema.statementLines)
        .where(
          and(
            eq(schema.statementLines.accountId, accountId),
            inArray(schema.statementLines.fingerprint, [...fingerprints]),
          ),
        )
      return new Set(rows.map((row) => row.fingerprint))
    },
    append: async (statementImport, lines, event) => {
      const { closingBalance, ...rest } = statementImport
      await tx.insert(schema.statementImports).values({
        ...rest,
        tenantId,
        closingBalance: closingBalance?.amount ?? null,
        closingBalanceOn: closingBalance?.on ?? null,
      })
      for (let start = 0; start < lines.length; start += 500)
        await tx
          .insert(schema.statementLines)
          .values(lines.slice(start, start + 500).map((line) => ({ ...line, tenantId })))
      await publishAll(tx, tenantId, { pullDomainEvents: () => [event] })
    },
  }
}

function mapReconciliation(
  row: typeof schema.reconciliations.$inferSelect,
  items: readonly {
    statementLineId: string | null
    entryId: string | null
    applied: bigint
    date: string
  }[],
): Reconciliation {
  const reason = (value: string | null) => (value ? restored(Reason.create(value)) : null)
  return Reconciliation.rehydrate(
    {
      tenantId: row.tenantId,
      accountId: row.accountId,
      kind: RECONCILIATION_KINDS.includes(row.kind as ReconciliationKind)
        ? (row.kind as ReconciliationKind)
        : 'match',
      origin: RECONCILIATION_ORIGINS.includes(row.origin as ReconciliationOrigin)
        ? (row.origin as ReconciliationOrigin)
        : 'manual',
      suggestionKey: row.suggestionKey,
      suggestionScore: row.suggestionScore,
      corrected: row.corrected,
      items: items.map((item) => ({
        kind: item.statementLineId ? 'statement' : 'entry',
        id: item.statementLineId ?? item.entryId ?? '',
        applied: item.applied,
        date: item.date,
      })),
      reason: reason(row.reason),
      status: row.status === 'undone' ? 'undone' : 'active',
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt,
      undo:
        row.undoneBy && row.undoneAt && row.undoReason
          ? { by: row.undoneBy, at: row.undoneAt, reason: restored(Reason.create(row.undoReason)) }
          : null,
    },
    new UniqueEntityID(row.id),
  )
}

export function reconciliationsRepository(
  tx: Transaction,
  tenantId: string,
): ReconciliationsRepository {
  return {
    findLines: async (ids) => {
      if (ids.length === 0) return []
      const rows = await tx
        .select()
        .from(schema.statementLines)
        .where(inArray(schema.statementLines.id, [...ids]))
      const applied = await appliedTo(tx, 'statement_line_id', ids)
      return rows.map((row) => ({ value: mapLine(row), applied: applied.get(row.id) ?? 0n }))
    },
    findEntries: async (ids) => {
      if (ids.length === 0) return []
      const rows = await tx
        .select()
        .from(schema.journalEntries)
        .where(inArray(schema.journalEntries.id, [...ids]))
      const applied = await appliedTo(tx, 'entry_id', ids)
      return rows.map((row) => ({ value: mapEntry(row), applied: applied.get(row.id) ?? 0n }))
    },
    findForUpdate: async (id) => {
      const [row] = await tx
        .select()
        .from(schema.reconciliations)
        .where(eq(schema.reconciliations.id, id))
        .limit(1)
        .for('update')
      if (!row) return null
      const items = (await tx.execute(sql`
        select i.statement_line_id, i.entry_id, i.applied::text as applied,
          coalesce(l.posted_on, e.value_on)::text as date
        from reconciliation_items i
        left join statement_lines l on l.tenant_id = i.tenant_id and l.id = i.statement_line_id
        left join journal_entries e on e.tenant_id = i.tenant_id and e.id = i.entry_id
        where i.reconciliation_id = ${id}`)) as unknown as {
        statement_line_id: string | null
        entry_id: string | null
        applied: string
        date: string
      }[]
      return mapReconciliation(
        row,
        items.map((item) => ({
          statementLineId: item.statement_line_id,
          entryId: item.entry_id,
          applied: BigInt(item.applied),
          date: item.date,
        })),
      )
    },
    create: async (reconciliation) => {
      const row = reconciliation.toSnapshot()
      if (row.tenantId !== tenantId) throw new Error('Aggregate tenant does not match transaction')
      const { items, ...rest } = row
      await tx.insert(schema.reconciliations).values(rest)
      await tx.insert(schema.reconciliationItems).values(
        items.map((item) => ({
          tenantId,
          reconciliationId: row.id,
          statementLineId: item.kind === 'statement' ? item.id : null,
          entryId: item.kind === 'entry' ? item.id : null,
          applied: BigInt(item.applied),
        })),
      )
      await publishAll(tx, tenantId, reconciliation)
    },
    save: async (reconciliation) => {
      const row = reconciliation.toSnapshot()
      await tx
        .update(schema.reconciliations)
        .set({
          status: row.status,
          undoneBy: row.undoneBy,
          undoneAt: row.undoneAt,
          undoReason: row.undoReason,
        })
        .where(eq(schema.reconciliations.id, row.id))
      await publishAll(tx, tenantId, reconciliation)
    },
    dismiss: async (accountId, key, score, actor, now) => {
      await tx
        .insert(schema.dismissedSuggestions)
        .values({
          tenantId,
          accountId,
          suggestionKey: key,
          score,
          dismissedBy: actor,
          dismissedAt: now,
        })
        .onConflictDoNothing()
    },
    openCandidates: async (accountId, range) => {
      const lines = (await tx.execute(sql`
        select l.id, l.posted_on::text as date, l.description, l.counterparty, l.document_id,
          (l.amount - sign(l.amount) * coalesce(a.applied, 0))::text as open
        from statement_lines l
        left join lateral (
          select sum(abs(i.applied)) as applied from reconciliation_items i
          join reconciliations r on r.tenant_id = i.tenant_id and r.id = i.reconciliation_id
          where r.status = 'active' and i.statement_line_id = l.id) a on true
        where l.account_id = ${accountId}
          and l.posted_on between ${range.from}::date and ${range.to}::date
          and abs(l.amount) > coalesce(a.applied, 0)
        order by l.posted_on, l.id`)) as unknown as Record<string, string | null>[]
      const entries = (await tx.execute(sql`
        select e.id, e.value_on::text as date, e.memo, e.counterparty,
          ((case when e.direction = 'inflow' then 1 else -1 end) * (e.amount - coalesce(a.applied, 0)))::text as open
        from journal_entries e
        left join lateral (
          select sum(abs(i.applied)) as applied from reconciliation_items i
          join reconciliations r on r.tenant_id = i.tenant_id and r.id = i.reconciliation_id
          where r.status = 'active' and i.entry_id = e.id) a on true
        where e.account_id = ${accountId}
          and e.value_on between ${range.from}::date and ${range.to}::date
          and e.amount > coalesce(a.applied, 0)
        order by e.value_on, e.id`)) as unknown as Record<string, string | null>[]
      return {
        lines: lines.map((row) => ({
          id: String(row.id),
          date: String(row.date),
          open: BigInt(String(row.open)),
          description: String(row.description ?? ''),
          counterparty: row.counterparty ?? null,
          documentId: row.document_id ?? null,
        })),
        entries: entries.map((row) => ({
          id: String(row.id),
          date: String(row.date),
          open: BigInt(String(row.open)),
          memo: row.memo ?? null,
          counterparty: row.counterparty ?? null,
        })),
      }
    },
    dismissedKeys: async (accountId) =>
      new Set(
        (
          await tx
            .select({ key: schema.dismissedSuggestions.suggestionKey })
            .from(schema.dismissedSuggestions)
            .where(eq(schema.dismissedSuggestions.accountId, accountId))
        ).map((row) => row.key),
      ),
  }
}

export function closuresRepository(tx: Transaction, tenantId: string): ClosuresRepository {
  return {
    inForce: async (accountId) => {
      const [row] = await tx
        .select()
        .from(schema.reconciliationClosures)
        .where(
          and(
            eq(schema.reconciliationClosures.accountId, accountId),
            isNull(schema.reconciliationClosures.reopenedAt),
          ),
        )
        .limit(1)
      return row ?? null
    },
    close: async (closure) => {
      await tx.insert(schema.reconciliationClosures).values({ ...closure, tenantId })
    },
    reopen: async (id, actor, reason, now) => {
      await tx
        .update(schema.reconciliationClosures)
        .set({ reopenedBy: actor, reopenedAt: now, reopenReason: reason })
        .where(eq(schema.reconciliationClosures.id, id))
    },
    openLinesThrough: async (accountId, through) => {
      const [row] = (await tx.execute(sql`
        select count(*)::int as open from statement_lines l
        where l.account_id = ${accountId} and l.posted_on <= ${through}::date
          and abs(l.amount) > coalesce((
            select sum(abs(i.applied)) from reconciliation_items i
            join reconciliations r on r.tenant_id = i.tenant_id and r.id = i.reconciliation_id
            where r.status = 'active' and i.statement_line_id = l.id), 0)`)) as unknown as {
        open: number
      }[]
      return row?.open ?? 0
    },
  }
}
