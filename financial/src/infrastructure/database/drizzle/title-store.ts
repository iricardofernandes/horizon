import { createHash, randomBytes } from 'node:crypto'
import { context, propagation, trace } from '@opentelemetry/api'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { AuditRecord, AuditTrail } from '@/application/ports/unit-of-work'
import { canonicalJson } from '@/core/audit/canonical-json'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import {
  type Settlement,
  TITLE_DIRECTIONS,
  TITLE_STATUSES,
  Title,
  type TitleDirection,
  type TitleOrigin,
  type TitleStatus,
} from '@/domain/entities/title'
import type {
  PartyProjectionRepository,
  TitlesRepository,
} from '@/domain/repositories/title-repositories'
import { BusinessDate, Currency, Money, Share } from '@/domain/value-objects/financial-values'
import { DocumentNumber, Memo, Reason } from '@/domain/value-objects/title-values'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export const GENESIS_HASH = '0'.repeat(64)

function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted title value', { cause: result.value })
  return result.value
}

function oneOf<T extends string>(allowed: readonly T[], value: string, what: string): T {
  if (!allowed.includes(value as T)) throw new Error(`Invalid persisted ${what}`)
  return value as T
}

type TitleRow = typeof schema.titles.$inferSelect
type InstallmentRow = typeof schema.titleInstallments.$inferSelect
type SettlementRow = typeof schema.titleSettlements.$inferSelect

export function mapTitle(
  row: TitleRow,
  installments: readonly InstallmentRow[],
  settlements: readonly SettlementRow[],
): Title {
  const currency = restored(Currency.create(row.currency))
  const money = (amount: bigint) => Money.of(amount, currency)
  const origin: TitleOrigin =
    row.originType === 'sales-order' && row.originOrderId
      ? { type: 'sales-order', orderId: row.originOrderId }
      : { type: 'manual' }
  const closure =
    row.closedAt && row.closureReason
      ? { at: row.closedAt, reason: restored(Reason.create(row.closureReason)) }
      : null
  return Title.rehydrate(
    {
      tenantId: row.tenantId,
      direction: oneOf<TitleDirection>(TITLE_DIRECTIONS, row.direction, 'title direction'),
      origin,
      partyId: row.partyId,
      documentNumber: restored(DocumentNumber.create(row.documentNumber)),
      description: row.description ? restored(Memo.create(row.description)) : null,
      currency,
      categoryId: row.categoryId,
      issuedOn: restored(BusinessDate.create(row.issuedOn)),
      competenceOn: restored(BusinessDate.create(row.competenceOn)),
      installments: [...installments]
        .sort((a, b) => a.number - b.number)
        .map((installment) => ({
          number: installment.number,
          dueOn: restored(BusinessDate.create(installment.dueOn)),
          amount: money(installment.amount),
        })),
      allocations: row.allocations.map((entry) => ({
        dimensionId: entry.dimensionId,
        share: restored(Share.fromBasisPoints(entry.basisPoints)),
      })),
      status: oneOf<TitleStatus>(TITLE_STATUSES, row.status, 'title status'),
      settlements: settlements.map(
        (settlement): Settlement => ({
          id: settlement.id,
          installmentNumber: settlement.installmentNumber,
          settledOn: restored(BusinessDate.create(settlement.settledOn)),
          received: money(settlement.received),
          discount: money(settlement.discount),
          interest: money(settlement.interest),
          penalty: money(settlement.penalty),
          paymentMethodId: settlement.paymentMethodId,
          recordedAt: settlement.recordedAt,
          reversal:
            settlement.reversedAt && settlement.reversalReason
              ? {
                  at: settlement.reversedAt,
                  reason: restored(Reason.create(settlement.reversalReason)),
                }
              : null,
        }),
      ),
      postedAt: row.postedAt,
      closure,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

export async function loadTitles(
  tx: Transaction,
  rows: readonly TitleRow[],
): Promise<readonly Title[]> {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const [installments, settlements] = await Promise.all([
    tx
      .select()
      .from(schema.titleInstallments)
      .where(inArray(schema.titleInstallments.titleId, ids)),
    tx
      .select()
      .from(schema.titleSettlements)
      .where(inArray(schema.titleSettlements.titleId, ids))
      .orderBy(asc(schema.titleSettlements.recordedAt), asc(schema.titleSettlements.id)),
  ])
  return rows.map((row) =>
    mapTitle(
      row,
      installments.filter((installment) => installment.titleId === row.id),
      settlements.filter((settlement) => settlement.titleId === row.id),
    ),
  )
}

function titleRow(title: Title) {
  const snapshot = title.toSnapshot()
  const nextDue = snapshot.installments.find((installment) => installment.outstanding !== '0')
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    direction: snapshot.direction,
    originType: snapshot.origin.type,
    originOrderId: snapshot.origin.type === 'sales-order' ? snapshot.origin.orderId : null,
    partyId: snapshot.partyId,
    documentNumber: snapshot.documentNumber,
    description: snapshot.description,
    currency: snapshot.currency,
    categoryId: snapshot.categoryId,
    issuedOn: snapshot.issuedOn,
    competenceOn: snapshot.competenceOn,
    allocations: [...snapshot.allocations],
    status: snapshot.status,
    settlementState: snapshot.settlementState,
    total: BigInt(snapshot.total),
    outstanding: BigInt(snapshot.outstanding),
    nextDueOn: snapshot.status === 'posted' ? (nextDue?.dueOn ?? null) : null,
    postedAt: snapshot.postedAt,
    closedAt: snapshot.closedAt,
    closureReason: snapshot.closureReason,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  }
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

export function titlesRepository(tx: Transaction, tenantId: string): TitlesRepository {
  const assertTenant = (title: Title) => {
    if (title.tenantId !== tenantId) throw new Error('Aggregate tenant does not match transaction')
  }
  const lockedOne = async (condition: ReturnType<typeof eq>) => {
    const rows = await tx.select().from(schema.titles).where(condition).limit(1).for('update')
    const [title] = await loadTitles(tx, rows)
    return title ?? null
  }
  const writeSchedule = async (title: Title) => {
    const snapshot = title.toSnapshot()
    await tx
      .delete(schema.titleInstallments)
      .where(eq(schema.titleInstallments.titleId, snapshot.id))
    await tx.insert(schema.titleInstallments).values(
      snapshot.installments.map((installment) => ({
        tenantId,
        titleId: snapshot.id,
        number: installment.number,
        dueOn: installment.dueOn,
        amount: BigInt(installment.amount),
        outstanding: BigInt(installment.outstanding),
        state: installment.state,
      })),
    )
  }
  const writeBalances = async (title: Title) => {
    const snapshot = title.toSnapshot()
    for (const installment of snapshot.installments)
      await tx
        .update(schema.titleInstallments)
        .set({ outstanding: BigInt(installment.outstanding), state: installment.state })
        .where(
          and(
            eq(schema.titleInstallments.titleId, snapshot.id),
            eq(schema.titleInstallments.number, installment.number),
          ),
        )
    const known = new Map(
      (
        await tx
          .select({
            id: schema.titleSettlements.id,
            reversedAt: schema.titleSettlements.reversedAt,
          })
          .from(schema.titleSettlements)
          .where(eq(schema.titleSettlements.titleId, snapshot.id))
      ).map((row) => [row.id, row.reversedAt]),
    )
    for (const settlement of snapshot.settlements) {
      if (!known.has(settlement.id))
        await tx.insert(schema.titleSettlements).values({
          id: settlement.id,
          tenantId,
          titleId: snapshot.id,
          installmentNumber: settlement.installmentNumber,
          settledOn: settlement.settledOn,
          received: BigInt(settlement.received),
          discount: BigInt(settlement.discount),
          interest: BigInt(settlement.interest),
          penalty: BigInt(settlement.penalty),
          paymentMethodId: settlement.paymentMethodId,
          recordedAt: settlement.recordedAt,
          reversedAt: settlement.reversedAt,
          reversalReason: settlement.reversalReason,
        })
      else if (settlement.reversedAt && !known.get(settlement.id))
        await tx
          .update(schema.titleSettlements)
          .set({ reversedAt: settlement.reversedAt, reversalReason: settlement.reversalReason })
          .where(eq(schema.titleSettlements.id, settlement.id))
    }
  }
  return {
    findForUpdate: (id) => lockedOne(eq(schema.titles.id, id)),
    findByOrderForUpdate: async (direction, orderId) => {
      const rows = await tx
        .select()
        .from(schema.titles)
        .where(
          and(eq(schema.titles.direction, direction), eq(schema.titles.originOrderId, orderId)),
        )
        .limit(1)
        .for('update')
      const [title] = await loadTitles(tx, rows)
      return title ?? null
    },
    create: async (title) => {
      assertTenant(title)
      await tx.insert(schema.titles).values(titleRow(title))
      await writeSchedule(title)
      for (const event of title.pullDomainEvents()) await publish(tx, tenantId, event)
    },
    save: async (title) => {
      assertTenant(title)
      const row = titleRow(title)
      const [previous] = await tx
        .select({ status: schema.titles.status })
        .from(schema.titles)
        .where(eq(schema.titles.id, row.id))
      await tx.update(schema.titles).set(row).where(eq(schema.titles.id, row.id))
      // A draft's schedule may have been rewritten; after posting only balances change.
      if (previous?.status === 'draft' && row.status === 'draft') await writeSchedule(title)
      else await writeBalances(title)
      for (const event of title.pullDomainEvents()) await publish(tx, tenantId, event)
    },
  }
}

export function partyProjection(tx: Transaction, tenantId: string): PartyProjectionRepository {
  return {
    find: async (partyId) => {
      const [row] = await tx
        .select()
        .from(schema.partyProjection)
        .where(eq(schema.partyProjection.partyId, partyId))
        .limit(1)
      return row ?? null
    },
    record: async (party, now) => {
      const written = await tx
        .insert(schema.partyProjection)
        .values({ tenantId, ...party, roles: [...party.roles], erased: false, updatedAt: now })
        .onConflictDoUpdate({
          target: [schema.partyProjection.tenantId, schema.partyProjection.partyId],
          set: {
            legalName: party.legalName,
            roles: [...party.roles],
            active: party.active,
            updatedAt: now,
          },
          setWhere: eq(schema.partyProjection.erased, false),
        })
        .returning({ partyId: schema.partyProjection.partyId })
      return written.length > 0 ? 'recorded' : 'ignored'
    },
    forget: async (partyId, now) => {
      await tx
        .insert(schema.partyProjection)
        .values({
          tenantId,
          partyId,
          legalName: null,
          roles: [],
          active: false,
          erased: true,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.partyProjection.tenantId, schema.partyProjection.partyId],
          set: { legalName: null, active: false, erased: true, updatedAt: now },
        })
    },
  }
}

/** `hash = sha256(previous_hash || canonical_json(entry))`, as identity's chain (ADR 0025). */
export function auditHash(previousHash: string, entry: Record<string, unknown>): string {
  return createHash('sha256')
    .update(previousHash, 'utf8')
    .update(canonicalJson(entry), 'utf8')
    .digest('hex')
}

export function auditTrail(tx: Transaction, tenantId: string): AuditTrail {
  return {
    append: async (record: AuditRecord) => {
      // A per-tenant transaction lock serializes chain appends, including the first link.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`financial.audit:${tenantId}`}, 0))`,
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
