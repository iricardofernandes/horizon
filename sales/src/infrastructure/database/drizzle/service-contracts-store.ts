import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import {
  CONTRACT_STAGES,
  type ContractStage,
  ServiceContract,
} from '@/domain/entities/service-contract'
import type { ServiceContractsRepository } from '@/domain/repositories/sales-repositories'
import {
  type BilledPeriod,
  CREDIT_REASONS,
  type CreditReason,
} from '@/domain/services/contract-billing'
import {
  type ContractRevision,
  RECURRENCES,
  REVISION_KINDS,
  type Recurrence,
  type RevisionKind,
} from '@/domain/services/contract-schedule'
import {
  BusinessDate,
  Currency,
  LineDescription,
  Money,
  PaymentTerms,
  Quantity,
  Reason,
} from '@/domain/value-objects/sales-values'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type Snapshot = ReturnType<ServiceContract['toSnapshot']>

/** The service contracts of the tenant the transaction is scoped to (Phase 51). */
export function serviceContractsRepository(
  tx: Transaction,
  tenantId: string,
  publish: (contract: ServiceContract) => Promise<void>,
): ServiceContractsRepository {
  const assertTenant = (actual: string) => {
    if (actual !== tenantId) throw new Error('Aggregate tenant does not match transaction')
  }
  return {
    findById: (id) => loadContract(tx, id, true),
    read: (id) => loadContract(tx, id, false),
    create: async (contract) => {
      const row = contract.toSnapshot()
      assertTenant(row.tenantId)
      await tx.insert(schema.serviceContracts).values(contractRow(row))
      await writeRevisions(tx, tenantId, row, new Set())
      await writeSuspensions(tx, tenantId, row, new Map())
      await writeBilledPeriods(tx, tenantId, row, new Map())
      await publish(contract)
    },
    save: async (contract) => {
      const row = contract.toSnapshot()
      assertTenant(row.tenantId)
      const { id, ...changed } = contractRow(row)
      await tx
        .update(schema.serviceContracts)
        .set(changed)
        .where(
          and(eq(schema.serviceContracts.tenantId, tenantId), eq(schema.serviceContracts.id, id)),
        )
      const revisions = await tx
        .select({ revision: schema.serviceContractRevisions.revision })
        .from(schema.serviceContractRevisions)
        .where(eq(schema.serviceContractRevisions.contractId, row.id))
      await writeRevisions(tx, tenantId, row, new Set(revisions.map((stored) => stored.revision)))
      const suspensions = await tx
        .select({
          id: schema.serviceContractSuspensions.id,
          until: schema.serviceContractSuspensions.untilDate,
        })
        .from(schema.serviceContractSuspensions)
        .where(eq(schema.serviceContractSuspensions.contractId, row.id))
      await writeSuspensions(
        tx,
        tenantId,
        row,
        new Map(suspensions.map((stored) => [stored.id, stored.until])),
      )
      const billed = await tx
        .select({
          id: schema.contractBilledPeriods.id,
          credit: schema.contractBilledPeriods.creditReasonCode,
        })
        .from(schema.contractBilledPeriods)
        .where(eq(schema.contractBilledPeriods.contractId, row.id))
      await writeBilledPeriods(
        tx,
        tenantId,
        row,
        new Map(billed.map((stored) => [stored.id, stored.credit])),
      )
      await publish(contract)
    },
    renewable: async (horizon) => {
      const rows = await tx
        .select({ id: schema.serviceContracts.id })
        .from(schema.serviceContracts)
        .where(
          and(
            eq(schema.serviceContracts.stage, 'active'),
            eq(schema.serviceContracts.autoRenew, true),
            lte(schema.serviceContracts.endsOn, horizon),
            or(
              isNull(schema.serviceContracts.cancelledFrom),
              sql`${schema.serviceContracts.cancelledFrom} > ${schema.serviceContracts.endsOn}`,
            ),
          ),
        )
        .orderBy(asc(schema.serviceContracts.endsOn))
        .limit(500)
      return rows.map((row) => row.id)
    },
    inForce: async (from, to) => {
      const rows = await tx
        .select({ id: schema.serviceContracts.id })
        .from(schema.serviceContracts)
        .where(
          and(
            eq(schema.serviceContracts.stage, 'active'),
            lte(schema.serviceContracts.startsOn, to),
            or(isNull(schema.serviceContracts.endsOn), gte(schema.serviceContracts.endsOn, from)),
          ),
        )
        .orderBy(asc(schema.serviceContracts.createdAt), asc(schema.serviceContracts.id))
      return rows.map((row) => row.id)
    },
  }
}

export async function listContracts(tx: Transaction): Promise<readonly ServiceContract[]> {
  const rows = await tx
    .select({ id: schema.serviceContracts.id })
    .from(schema.serviceContracts)
    .orderBy(desc(schema.serviceContracts.createdAt))
    .limit(100)
  const contracts = await Promise.all(rows.map((row) => loadContract(tx, row.id, false)))
  return contracts.flatMap((contract) => (contract ? [contract] : []))
}

export function findContract(tx: Transaction, id: string): Promise<ServiceContract | null> {
  return loadContract(tx, id, false)
}

async function loadContract(
  tx: Transaction,
  id: string,
  forUpdate: boolean,
): Promise<ServiceContract | null> {
  const query = tx
    .select()
    .from(schema.serviceContracts)
    .where(eq(schema.serviceContracts.id, id))
    .limit(1)
  const [row] = forUpdate ? await query.for('update') : await query
  if (!row) return null
  const revisions = await tx
    .select()
    .from(schema.serviceContractRevisions)
    .where(eq(schema.serviceContractRevisions.contractId, row.id))
    .orderBy(asc(schema.serviceContractRevisions.revision))
  const lines = await tx
    .select()
    .from(schema.serviceContractRevisionLines)
    .where(eq(schema.serviceContractRevisionLines.contractId, row.id))
    .orderBy(asc(schema.serviceContractRevisionLines.position))
  const suspensions = await tx
    .select()
    .from(schema.serviceContractSuspensions)
    .where(eq(schema.serviceContractSuspensions.contractId, row.id))
    .orderBy(asc(schema.serviceContractSuspensions.fromDate))
  const currency = restored(Currency.create(row.currency))
  const date = (value: string) => restored(BusinessDate.create(value))
  const billedPeriods = await loadBilledPeriods(tx, row.id, currency)
  return ServiceContract.rehydrate(
    {
      tenantId: row.tenantId,
      customerId: row.customerId,
      currency,
      startsOn: date(row.startsOn),
      endsOn: row.endsOn ? date(row.endsOn) : null,
      billingDay: row.billingDay,
      autoRenew: row.autoRenew,
      termMonths: row.termMonths,
      paymentTerms: restored(PaymentTerms.create(row.paymentTermDays)),
      sellerId: row.sellerId,
      notes: row.notes,
      stage: oneOf<ContractStage>(CONTRACT_STAGES, row.stage),
      revisions: revisions.map(
        (revision): ContractRevision => ({
          number: revision.revision,
          kind: oneOf<RevisionKind>(REVISION_KINDS, revision.kind),
          effectiveFrom: date(revision.effectiveFrom),
          recurrence: oneOf<Recurrence>(RECURRENCES, revision.recurrence),
          readjustmentBasisPoints: revision.readjustmentBasisPoints,
          reason: revision.reason ? restored(Reason.create(revision.reason)) : null,
          createdBy: revision.createdBy,
          createdAt: revision.createdAt,
          lines: lines
            .filter((line) => line.revision === revision.revision)
            .map((line) => ({
              lineId: line.lineId,
              itemId: line.itemId,
              description: restored(LineDescription.create(line.description)),
              quantity: Quantity.fromMicros(line.quantity),
              unitPrice: Money.fromAmount(line.unitPrice, currency),
            })),
        }),
      ),
      suspensions: suspensions.map((suspension) => ({
        id: suspension.id,
        from: date(suspension.fromDate),
        until: suspension.untilDate ? date(suspension.untilDate) : null,
        reason: restored(Reason.create(suspension.reason)),
        createdBy: suspension.createdBy,
        createdAt: suspension.createdAt,
      })),
      billedPeriods,
      cancellation:
        row.cancelledFrom && row.cancellationReason && row.cancelledBy && row.cancelledAt
          ? {
              from: date(row.cancelledFrom),
              reason: restored(Reason.create(row.cancellationReason)),
              by: row.cancelledBy,
              at: row.cancelledAt,
            }
          : null,
      createdBy: row.createdBy,
      activatedAt: row.activatedAt,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function contractRow(row: Snapshot) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    customerId: row.customerId,
    currency: row.currency,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    billingDay: row.billingDay,
    autoRenew: row.autoRenew,
    termMonths: row.termMonths,
    paymentTermDays: [...row.paymentTermDays],
    sellerId: row.sellerId,
    notes: row.notes,
    stage: row.stage,
    cancelledFrom: row.cancelledFrom,
    cancellationReason: row.cancellationReason,
    cancelledBy: row.cancelledBy,
    cancelledAt: row.cancelledAt,
    createdBy: row.createdBy,
    activatedAt: row.activatedAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Inserts the revisions not stored yet; a stored revision is never rewritten. */
async function writeRevisions(
  tx: Transaction,
  tenantId: string,
  row: Snapshot,
  stored: ReadonlySet<number>,
): Promise<void> {
  for (const revision of row.revisions) {
    if (stored.has(revision.number)) continue
    await tx.insert(schema.serviceContractRevisions).values({
      tenantId,
      contractId: row.id,
      revision: revision.number,
      kind: revision.kind,
      effectiveFrom: revision.effectiveFrom,
      recurrence: revision.recurrence,
      readjustmentBasisPoints: revision.readjustmentBasisPoints,
      reason: revision.reason,
      createdBy: revision.createdBy,
      createdAt: revision.createdAt,
    })
    await tx.insert(schema.serviceContractRevisionLines).values(
      revision.lines.map((line, position) => ({
        tenantId,
        contractId: row.id,
        revision: revision.number,
        lineId: line.lineId,
        itemId: line.itemId,
        description: line.description,
        quantity: restored(Quantity.create(line.quantity)).micros,
        unitPrice: BigInt(line.unitPrice),
        position,
      })),
    )
  }
}

/** Inserts new suspensions and records a resumption on one that had none. */
async function writeSuspensions(
  tx: Transaction,
  tenantId: string,
  row: Snapshot,
  stored: ReadonlyMap<string, string | null>,
): Promise<void> {
  for (const suspension of row.suspensions) {
    if (!stored.has(suspension.id)) {
      await tx.insert(schema.serviceContractSuspensions).values({
        id: suspension.id,
        tenantId,
        contractId: row.id,
        fromDate: suspension.from,
        untilDate: suspension.until,
        reason: suspension.reason,
        createdBy: suspension.createdBy,
        createdAt: suspension.createdAt,
      })
      continue
    }
    if (stored.get(suspension.id) === null && suspension.until)
      await tx
        .update(schema.serviceContractSuspensions)
        .set({ untilDate: suspension.until })
        .where(
          and(
            eq(schema.serviceContractSuspensions.tenantId, tenantId),
            eq(schema.serviceContractSuspensions.id, suspension.id),
          ),
        )
  }
}

async function loadBilledPeriods(
  tx: Transaction,
  contractId: string,
  currency: Currency,
): Promise<readonly BilledPeriod[]> {
  const periods = await tx
    .select()
    .from(schema.contractBilledPeriods)
    .where(eq(schema.contractBilledPeriods.contractId, contractId))
    .orderBy(asc(schema.contractBilledPeriods.startsOn))
  if (periods.length === 0) return []
  const lines = await tx
    .select()
    .from(schema.contractBilledPeriodLines)
    .where(
      inArray(
        schema.contractBilledPeriodLines.billedPeriodId,
        periods.map((period) => period.id),
      ),
    )
    .orderBy(asc(schema.contractBilledPeriodLines.position))
  const date = (value: string) => restored(BusinessDate.create(value))
  const money = (amount: bigint) => Money.fromAmount(amount, currency)
  return periods.map((period): BilledPeriod => {
    const credit = period.creditReasonCode
      ? {
          reasonCode: oneOf<CreditReason>(CREDIT_REASONS, period.creditReasonCode),
          reason: restored(Reason.create(period.creditReason ?? '')),
          creditedOn: date(period.creditedOn ?? ''),
          by: period.creditedBy ?? '',
          at: period.creditedAt ?? period.billedAt,
        }
      : null
    return {
      id: period.id,
      competence: period.competence,
      revision: period.revision,
      startsOn: date(period.startsOn),
      endsOn: date(period.endsOn),
      issuedOn: date(period.issuedOn),
      value: money(period.value),
      installments: period.installments.map((installment) => ({
        number: installment.number,
        dueOn: date(installment.dueOn),
        amount: money(BigInt(installment.amount)),
      })),
      runId: period.runId,
      billedBy: period.billedBy,
      billedAt: period.billedAt,
      credit,
      lines: lines
        .filter((line) => line.billedPeriodId === period.id)
        .map((line) => ({
          entryId: line.entryId,
          lineId: line.lineId,
          itemId: line.itemId,
          description: restored(LineDescription.create(line.description)),
          quantity: Quantity.fromMicros(line.quantity),
          unitPrice: money(line.unitPrice),
          lineTotal: money(line.amount),
          amount: money(line.amount),
        })),
    }
  })
}

/** Inserts the periods billed since the load, and records a credit on one that had none. */
async function writeBilledPeriods(
  tx: Transaction,
  tenantId: string,
  row: Snapshot,
  stored: ReadonlyMap<string, string | null>,
): Promise<void> {
  for (const period of row.billedPeriods) {
    if (stored.has(period.id)) {
      if (stored.get(period.id) === null && period.credit)
        await tx
          .update(schema.contractBilledPeriods)
          .set({
            creditReasonCode: period.credit.reasonCode,
            creditReason: period.credit.reason,
            creditedOn: period.credit.creditedOn,
            creditedBy: period.credit.by,
            creditedAt: period.credit.at,
          })
          .where(
            and(
              eq(schema.contractBilledPeriods.tenantId, tenantId),
              eq(schema.contractBilledPeriods.id, period.id),
            ),
          )
      continue
    }
    await tx.insert(schema.contractBilledPeriods).values({
      id: period.id,
      tenantId,
      contractId: row.id,
      competence: period.competence,
      revision: period.revision,
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      issuedOn: period.issuedOn,
      currency: row.currency,
      value: BigInt(period.value),
      installments: period.installments,
      runId: period.runId,
      billedBy: period.billedBy,
      billedAt: period.billedAt,
    })
    await tx.insert(schema.contractBilledPeriodLines).values(
      period.lines.map((line, position) => ({
        tenantId,
        entryId: line.entryId,
        billedPeriodId: period.id,
        lineId: line.lineId,
        itemId: line.itemId,
        description: line.description,
        quantity: restored(Quantity.create(line.quantity)).micros,
        unitPrice: BigInt(line.unitPrice),
        amount: BigInt(line.amount),
        position,
      })),
    )
  }
}

function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted service contract')
  return result.value
}

function oneOf<T extends string>(allowed: readonly T[], value: string): T {
  if (!allowed.includes(value as T)) throw new Error('Invalid persisted service contract value')
  return value as T
}
