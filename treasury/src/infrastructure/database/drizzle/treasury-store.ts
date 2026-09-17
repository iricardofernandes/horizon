import { createHash, randomBytes } from 'node:crypto'
import { context, propagation, trace } from '@opentelemetry/api'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { AuditRecord, AuditTrail, TreasuryScope } from '@/application/ports/unit-of-work'
import { canonicalJson } from '@/core/audit/canonical-json'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import { ACCOUNT_KINDS, Account, type AccountKind } from '@/domain/entities/account'
import {
  ENTRY_DIRECTIONS,
  ENTRY_SOURCES,
  type EntryDirection,
  type EntrySource,
  JournalEntry,
} from '@/domain/entities/journal-entry'
import { TRANSFER_STATUSES, Transfer, type TransferStatus } from '@/domain/entities/transfer'
import {
  AccountName,
  BankDetails,
  BusinessDate,
  Currency,
  Memo,
  Money,
  Reason,
} from '@/domain/value-objects/treasury-values'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export const GENESIS_HASH = '0'.repeat(64)

function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted treasury value', { cause: result.value })
  return result.value
}

function oneOf<T extends string>(allowed: readonly T[], value: string, what: string): T {
  if (!allowed.includes(value as T)) throw new Error(`Invalid persisted ${what}`)
  return value as T
}

function mapAccount(row: typeof schema.accounts.$inferSelect): Account {
  return Account.rehydrate(
    {
      tenantId: row.tenantId,
      kind: oneOf<AccountKind>(ACCOUNT_KINDS, row.kind, 'account kind'),
      name: restored(AccountName.create(row.name)),
      currency: restored(Currency.create(row.currency)),
      bank:
        row.bankCode && row.branch && row.accountNumber
          ? restored(
              BankDetails.create({
                bankCode: row.bankCode,
                branch: row.branch,
                accountNumber: row.accountNumber,
              }),
            )
          : null,
      openedOn: restored(BusinessDate.create(row.openedOn)),
      active: row.active,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

export function mapEntry(row: typeof schema.journalEntries.$inferSelect): JournalEntry {
  const currency = restored(Currency.create(row.currency))
  return JournalEntry.rehydrate(
    {
      tenantId: row.tenantId,
      accountId: row.accountId,
      direction: oneOf<EntryDirection>(ENTRY_DIRECTIONS, row.direction, 'entry direction'),
      amount: Money.of(row.amount, currency),
      valueOn: restored(BusinessDate.create(row.valueOn)),
      source: oneOf<EntrySource>(ENTRY_SOURCES, row.source, 'entry source'),
      transferId: row.transferId,
      reverses: row.reverses,
      counterparty: restored(Memo.create(row.counterparty ?? undefined, '/counterparty')),
      memo: restored(Memo.create(row.memo ?? undefined, '/memo')),
      reason: row.reason ? restored(Reason.create(row.reason)) : null,
      recordedAt: row.recordedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapTransfer(row: typeof schema.transfers.$inferSelect): Transfer {
  const currency = restored(Currency.create(row.currency))
  return Transfer.rehydrate(
    {
      tenantId: row.tenantId,
      fromAccountId: row.fromAccountId,
      toAccountId: row.toAccountId,
      amount: Money.of(row.amount, currency),
      fee: row.fee === null ? null : Money.of(row.fee, currency),
      valueOn: restored(BusinessDate.create(row.valueOn)),
      memo: restored(Memo.create(row.memo ?? undefined, '/memo')),
      status: oneOf<TransferStatus>(TRANSFER_STATUSES, row.status, 'transfer status'),
      postedAt: row.postedAt,
      cancellation:
        row.cancelledAt && row.cancellationReason
          ? { at: row.cancelledAt, reason: restored(Reason.create(row.cancellationReason)) }
          : null,
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

async function publishAll(
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
        sql`select pg_advisory_xact_lock(hashtextextended(${`treasury.audit:${tenantId}`}, 0))`,
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

export function makeScope(tx: Transaction, tenantId: string): TreasuryScope {
  const assertTenant = (actual: string) => {
    if (actual !== tenantId) throw new Error('Aggregate tenant does not match transaction')
  }
  return {
    tenantId,
    accounts: {
      findForUpdate: async (ids) => {
        const unique = [...new Set(ids)].sort()
        if (unique.length === 0) return []
        const rows = await tx
          .select()
          .from(schema.accounts)
          .where(inArray(schema.accounts.id, unique))
          .orderBy(asc(schema.accounts.id))
          .for('update')
        return rows.map(mapAccount)
      },
      findByName: async (name) => {
        const [row] = await tx
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.name, name))
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
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.journalEntries)
          .where(eq(schema.journalEntries.id, id))
          .limit(1)
        return row ? mapEntry(row) : null
      },
      findReversalOf: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.journalEntries)
          .where(eq(schema.journalEntries.reverses, id))
          .limit(1)
        return row ? mapEntry(row) : null
      },
      findLegsOf: async (transferId) =>
        (
          await tx
            .select()
            .from(schema.journalEntries)
            .where(
              and(
                eq(schema.journalEntries.transferId, transferId),
                inArray(schema.journalEntries.source, ['transfer', 'transfer-fee']),
              ),
            )
            .orderBy(asc(schema.journalEntries.recordedAt), asc(schema.journalEntries.id))
        ).map(mapEntry),
      append: async (entries) => {
        for (const entry of entries) {
          const row = entry.toSnapshot()
          assertTenant(row.tenantId)
          await tx.insert(schema.journalEntries).values({ ...row, amount: BigInt(row.amount) })
          await publishAll(tx, tenantId, entry)
        }
      },
    },
    transfers: {
      findForUpdate: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.transfers)
          .where(eq(schema.transfers.id, id))
          .limit(1)
          .for('update')
        return row ? mapTransfer(row) : null
      },
      create: async (transfer) => {
        const row = transfer.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.transfers).values({
          ...row,
          amount: BigInt(row.amount),
          fee: row.fee === null ? null : BigInt(row.fee),
        })
        await publishAll(tx, tenantId, transfer)
      },
      save: async (transfer) => {
        const row = transfer.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.transfers)
          .set({
            status: row.status,
            cancelledAt: row.cancelledAt,
            cancellationReason: row.cancellationReason,
          })
          .where(eq(schema.transfers.id, row.id))
        await publishAll(tx, tenantId, transfer)
      },
    },
    audit: auditTrail(tx, tenantId),
  }
}
