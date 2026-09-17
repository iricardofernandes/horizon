import { createHash, randomBytes } from 'node:crypto'
import { context, propagation, trace } from '@opentelemetry/api'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { AuditRecord, AuditTrail, LedgerScope } from '@/application/ports/unit-of-work'
import { canonicalJson } from '@/core/audit/canonical-json'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import {
  AccountingPeriod,
  PERIOD_STATUSES,
  type PeriodStatus,
} from '@/domain/entities/accounting-period'
import {
  JournalTransaction,
  TRANSACTION_SOURCES,
  TRANSACTION_STATUSES,
  type TransactionLine,
  type TransactionSource,
  type TransactionStatus,
} from '@/domain/entities/journal-transaction'
import {
  ACCOUNT_TYPES,
  type AccountType,
  ENTRY_SIDES,
  type EntrySide,
  LedgerAccount,
} from '@/domain/entities/ledger-account'
import {
  AccountCode,
  AccountName,
  BusinessDate,
  Currency,
  Memo,
  Money,
  Period,
  Reason,
  Reference,
} from '@/domain/value-objects/ledger-values'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export const GENESIS_HASH = '0'.repeat(64)

export function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted ledger value', { cause: result.value })
  return result.value
}

function oneOf<T extends string>(allowed: readonly T[], value: string, what: string): T {
  if (!allowed.includes(value as T)) throw new Error(`Invalid persisted ${what}`)
  return value as T
}

function mapAccount(row: typeof schema.accounts.$inferSelect): LedgerAccount {
  return LedgerAccount.rehydrate(
    {
      tenantId: row.tenantId,
      code: restored(AccountCode.create(row.code)),
      name: restored(AccountName.create(row.name)),
      type: oneOf<AccountType>(ACCOUNT_TYPES, row.type, 'account type'),
      parentId: row.parentId,
      postable: row.postable,
      currency: restored(Currency.create(row.currency)),
      active: row.active,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapPeriod(row: typeof schema.periods.$inferSelect): AccountingPeriod {
  return AccountingPeriod.rehydrate(
    {
      tenantId: row.tenantId,
      period: restored(Period.create(row.period)),
      status: oneOf<PeriodStatus>(PERIOD_STATUSES, row.status, 'period status'),
      closedBy: row.closedBy,
      closedAt: row.closedAt,
      reopenedBy: row.reopenedBy,
      reopenedAt: row.reopenedAt,
      reopenReason: row.reopenReason ? restored(Reason.create(row.reopenReason)) : null,
    },
    new UniqueEntityID(row.id),
  )
}

function mapTransaction(
  row: typeof schema.transactions.$inferSelect,
  lineRows: readonly (typeof schema.transactionLines.$inferSelect)[],
): JournalTransaction {
  const currency = restored(Currency.create(row.currency))
  const lines: TransactionLine[] = lineRows.map((line) => ({
    lineNumber: line.lineNumber,
    accountId: line.accountId,
    accountCode: line.accountCode,
    side: oneOf<EntrySide>(ENTRY_SIDES, line.side, 'entry side'),
    amount: Money.of(line.amount, currency),
    memo: restored(Memo.create(line.memo ?? undefined, '/memo')),
  }))
  return JournalTransaction.rehydrate(
    {
      tenantId: row.tenantId,
      reference: restored(Reference.create(row.reference)),
      postedOn: restored(BusinessDate.create(row.postedOn)),
      period: restored(Period.create(row.period)),
      currency,
      source: {
        type: oneOf<TransactionSource>(TRANSACTION_SOURCES, row.sourceType, 'transaction source'),
        id: row.sourceId,
      },
      memo: restored(Memo.create(row.memo ?? undefined, '/memo')),
      lines,
      status: oneOf<TransactionStatus>(TRANSACTION_STATUSES, row.status, 'transaction status'),
      reverses: row.reverses,
      reversedBy: row.reversedBy,
      reversalReason: row.reversalReason ? restored(Reason.create(row.reversalReason)) : null,
      postedAt: row.postedAt,
      reversedAt: row.reversedAt,
    },
    new UniqueEntityID(row.id),
  )
}

async function publish(tx: Transaction, tenantId: string, event: DomainEvent): Promise<void> {
  if (event.tenantId !== tenantId) throw new Error('Event tenant does not match transaction')
  const id = new UniqueEntityID().toString()
  const carrier: Record<string, string> = {}
  propagation.inject(context.active(), carrier)
  await tx.insert(schema.outbox).values({
    id,
    eventId: id,
    tenantId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    occurredAt: event.occurredAt,
    traceId:
      trace.getSpan(context.active())?.spanContext().traceId ?? randomBytes(16).toString('hex'),
    traceParent: carrier.traceparent ?? null,
    payload: { ...event.payloadOf() },
  })
}

export async function publishAll(
  tx: Transaction,
  tenantId: string,
  aggregate: { pullDomainEvents(): readonly DomainEvent[] },
) {
  for (const event of aggregate.pullDomainEvents()) await publish(tx, tenantId, event)
}

/** `hash = sha256(previous_hash || canonical_json(entry))`, as identity's chain (ADR 0025). */
export function auditHash(previousHash: string, entry: Record<string, unknown>): string {
  return createHash('sha256')
    .update(previousHash, 'utf8')
    .update(canonicalJson(entry), 'utf8')
    .digest('hex')
}

function auditTrail(tx: Transaction, tenantId: string): AuditTrail {
  return {
    append: async (record: AuditRecord) => {
      // A per-tenant transaction lock serializes chain appends, including the first link.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ledger.audit:${tenantId}`}, 0))`,
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
      await tx.insert(schema.auditLog).values({
        id: new UniqueEntityID().toString(),
        ...entry,
        previousHash,
        hash: auditHash(previousHash, entry),
      })
    },
  }
}

async function loadTransaction(
  tx: Transaction,
  row: typeof schema.transactions.$inferSelect,
): Promise<JournalTransaction> {
  const lines = await tx
    .select()
    .from(schema.transactionLines)
    .where(eq(schema.transactionLines.transactionId, row.id))
    .orderBy(asc(schema.transactionLines.lineNumber))
  return mapTransaction(row, lines)
}

export function makeScope(tx: Transaction, tenantId: string): LedgerScope {
  const assertTenant = (actual: string) => {
    if (actual !== tenantId) throw new Error('Aggregate tenant does not match transaction')
  }
  return {
    tenantId,
    accounts: {
      findMany: async (ids) => {
        const unique = [...new Set(ids)].sort()
        if (unique.length === 0) return []
        const rows = await tx
          .select()
          .from(schema.accounts)
          .where(inArray(schema.accounts.id, unique))
          .orderBy(asc(schema.accounts.id))
        return rows.map(mapAccount)
      },
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.id, id))
          .limit(1)
        return row ? mapAccount(row) : null
      },
      findForUpdate: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.id, id))
          .limit(1)
          .for('update')
        return row ? mapAccount(row) : null
      },
      findByCode: async (code) => {
        const [row] = await tx
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.code, code))
          .limit(1)
        return row ? mapAccount(row) : null
      },
      create: async (account) => {
        const row = account.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.accounts).values(row)
        await publishAll(tx, tenantId, account)
      },
      save: async (account) => {
        const row = account.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.accounts)
          .set({ active: row.active, updatedAt: row.updatedAt })
          .where(eq(schema.accounts.id, row.id))
        await publishAll(tx, tenantId, account)
      },
    },
    journal: {
      findForUpdate: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, id))
          .limit(1)
          .for('update')
        return row ? loadTransaction(tx, row) : null
      },
      post: async (transaction) => {
        const row = transaction.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.transactions).values({
          id: row.id,
          tenantId: row.tenantId,
          reference: row.reference,
          postedOn: row.postedOn,
          period: row.period,
          currency: row.currency,
          total: BigInt(row.total),
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          memo: row.memo,
          status: row.status,
          reverses: row.reverses,
          reversedBy: row.reversedBy,
          reversalReason: row.reversalReason,
          postedAt: row.postedAt,
          reversedAt: row.reversedAt,
        })
        await tx.insert(schema.transactionLines).values(
          row.lines.map((line) => ({
            tenantId: row.tenantId,
            transactionId: row.id,
            lineNumber: line.lineNumber,
            accountId: line.accountId,
            accountCode: line.accountCode,
            side: line.side,
            amount: BigInt(line.amount),
            currency: row.currency,
            postedOn: row.postedOn,
            period: row.period,
            memo: line.memo,
          })),
        )
        await publishAll(tx, tenantId, transaction)
      },
      save: async (transaction) => {
        const row = transaction.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.transactions)
          .set({
            status: row.status,
            reversedBy: row.reversedBy,
            reversalReason: row.reversalReason,
            reversedAt: row.reversedAt,
          })
          .where(eq(schema.transactions.id, row.id))
        await publishAll(tx, tenantId, transaction)
      },
    },
    periods: {
      findForUpdate: async (period) => {
        const [row] = await tx
          .select()
          .from(schema.periods)
          .where(eq(schema.periods.period, period))
          .limit(1)
          .for('update')
        return row ? mapPeriod(row) : null
      },
      isClosed: async (period) => {
        const [row] = await tx
          .select({ status: schema.periods.status })
          .from(schema.periods)
          .where(and(eq(schema.periods.period, period), eq(schema.periods.status, 'closed')))
          .limit(1)
        return row !== undefined
      },
      create: async (period) => {
        const row = period.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.periods).values(row)
        await publishAll(tx, tenantId, period)
      },
      save: async (period) => {
        const row = period.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.periods)
          .set({
            status: row.status,
            closedBy: row.closedBy,
            closedAt: row.closedAt,
            reopenedBy: row.reopenedBy,
            reopenedAt: row.reopenedAt,
            reopenReason: row.reopenReason,
          })
          .where(eq(schema.periods.id, row.id))
        await publishAll(tx, tenantId, period)
      },
    },
    audit: auditTrail(tx, tenantId),
    lockPeriod: async (period) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ledger.period:${tenantId}:${period}`}, 0))`,
      )
    },
  }
}
