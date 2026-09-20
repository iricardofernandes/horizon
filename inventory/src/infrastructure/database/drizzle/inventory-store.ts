import { createHash, randomBytes } from 'node:crypto'
import { context, propagation, trace } from '@opentelemetry/api'
import { and, asc, desc, eq, gt, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { AuditRecord, AuditTrail, InventoryScope } from '@/application/ports/unit-of-work'
import { canonicalJson } from '@/core/audit/canonical-json'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import type { LotHolding } from '@/domain/entities/lot-book'
import { LotBook, outstandingByItem } from '@/domain/entities/lot-book'
import {
  ADJUSTMENT_STATUSES,
  type AdjustmentDirection,
  type AdjustmentStatus,
  APPROVAL_STATES,
  type ApprovalState,
  StockAdjustment,
} from '@/domain/entities/stock-adjustment'
import { StockBalance } from '@/domain/entities/stock-balance'
import { COUNT_STATUSES, type CountStatus, StockCount } from '@/domain/entities/stock-count'
import { StockReservation } from '@/domain/entities/stock-reservation'
import { StockTransfer } from '@/domain/entities/stock-transfer'
import { Warehouse } from '@/domain/entities/warehouse'
import { InventoryStockMovedEvent } from '@/domain/events/inventory-events'
import type {
  AdjustmentPolicy,
  StockLevel,
  TrackedItem,
} from '@/domain/repositories/inventory-repositories'
import {
  Currency,
  Money,
  Note,
  Quantity,
  WarehouseName,
} from '@/domain/value-objects/inventory-values'
import { type AdjustmentReason, isAdjustmentReason } from '@/domain/value-objects/movement-origin'
import {
  ExpiryDate,
  type ItemTracking,
  LotCode,
  trackingOf,
  UNTRACKED,
} from '@/domain/value-objects/tracking'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export const GENESIS_HASH = '0'.repeat(64)

function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted inventory value', { cause: result.value })
  return result.value
}

const micros = (value: string): bigint => restored(Quantity.create(value)).micros

function money(amount: bigint | null, currency: string | null): Money | null {
  if (amount === null || currency === null) return null
  return Money.fromAmount(amount, restored(Currency.create(currency)))
}

function note(value: string | null): Note | null {
  return value === null ? null : restored(Note.create(value))
}

function mapBalance(
  row: typeof schema.stockBalances.$inferSelect,
  tracking: ItemTracking,
  lots: readonly (typeof schema.stockLots.$inferSelect)[],
): StockBalance {
  return StockBalance.rehydrate(
    {
      tenantId: row.tenantId,
      itemId: row.itemId,
      warehouseId: row.warehouseId,
      onHand: Quantity.fromMicros(row.onHand),
      reserved: Quantity.fromMicros(row.reserved),
      averageUnitCost: money(row.averageUnitCost, row.currency),
      tracking,
      lots: new LotBook(lots.map(mapLot)),
      version: row.version,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapLot(row: typeof schema.stockLots.$inferSelect): LotHolding {
  return {
    code: restored(LotCode.create(row.lotCode)),
    expiresOn: row.expiresOn === null ? null : restored(ExpiryDate.create(row.expiresOn)),
    onHand: Quantity.fromMicros(row.onHand),
    firstReceivedAt: row.firstReceivedAt,
  }
}

function mapTracking(row: typeof schema.itemTracking.$inferSelect | undefined): ItemTracking {
  return row ? restored(trackingOf(row.tracking, row.expiry)) : UNTRACKED
}

function mapWarehouse(row: typeof schema.warehouses.$inferSelect): Warehouse {
  return Warehouse.rehydrate(
    {
      tenantId: row.tenantId,
      name: restored(WarehouseName.create(row.name)),
      active: row.active === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapReservation(
  row: typeof schema.stockReservations.$inferSelect,
  lines: readonly (typeof schema.stockReservationLines.$inferSelect)[],
): StockReservation {
  if (
    row.status !== 'active' &&
    row.status !== 'confirmed' &&
    row.status !== 'shipped' &&
    row.status !== 'released'
  )
    throw new Error('Invalid persisted reservation status')
  return StockReservation.rehydrate(
    {
      tenantId: row.tenantId,
      orderId: row.orderId,
      orderVersion: row.orderVersion,
      status: row.status,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lines: lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        quantity: Quantity.fromMicros(line.quantity),
      })),
      shipped: lines
        .filter((line) => line.shipped > 0n)
        .map((line) => ({ lineId: line.lineId, quantity: Quantity.fromMicros(line.shipped) })),
    },
    new UniqueEntityID(row.id),
  )
}

function mapTransfer(
  row: typeof schema.stockTransfers.$inferSelect,
  lines: readonly (typeof schema.stockTransferLines.$inferSelect)[],
): StockTransfer {
  return StockTransfer.rehydrate(
    {
      tenantId: row.tenantId,
      sourceWarehouseId: row.sourceWarehouseId,
      destinationWarehouseId: row.destinationWarehouseId,
      lines: lines.map((line) => ({
        itemId: line.itemId,
        quantity: Quantity.fromMicros(line.quantity),
      })),
      note: note(row.note),
      movedBy: row.movedBy,
      movedAt: row.movedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapAdjustment(row: typeof schema.stockAdjustments.$inferSelect): StockAdjustment {
  if (!isAdjustmentReason(row.reason)) throw new Error('Invalid persisted adjustment reason')
  if (row.direction !== 'in' && row.direction !== 'out')
    throw new Error('Invalid persisted adjustment direction')
  const reason: AdjustmentReason = row.reason
  const direction: AdjustmentDirection = row.direction
  return StockAdjustment.rehydrate(
    {
      tenantId: row.tenantId,
      warehouseId: row.warehouseId,
      itemId: row.itemId,
      direction,
      lot: row.lotCode === null ? null : restored(LotCode.create(row.lotCode)),
      quantity: Quantity.fromMicros(row.quantity),
      reason,
      note: note(row.note),
      statedUnitCost: money(row.statedUnitCost, row.statedCurrency),
      value: money(row.value, row.valueCurrency),
      status: oneOf<AdjustmentStatus>(ADJUSTMENT_STATUSES, row.status, 'adjustment status'),
      approvalState: oneOf<ApprovalState>(APPROVAL_STATES, row.approvalState, 'approval state'),
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
      decisionReason: note(row.decisionReason),
      postedAt: row.postedAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapCount(
  row: typeof schema.stockCounts.$inferSelect,
  lines: readonly (typeof schema.stockCountLines.$inferSelect)[],
): StockCount {
  return StockCount.rehydrate(
    {
      tenantId: row.tenantId,
      warehouseId: row.warehouseId,
      lines: lines.map((line) => ({
        itemId: line.itemId,
        lot: line.lotCode === null ? null : restored(LotCode.create(line.lotCode)),
        expected: Quantity.fromMicros(line.expected),
        counted: line.counted === null ? null : Quantity.fromMicros(line.counted),
      })),
      note: note(row.note),
      status: oneOf<CountStatus>(COUNT_STATUSES, row.status, 'count status'),
      approvalState: oneOf<ApprovalState>(APPROVAL_STATES, row.approvalState, 'approval state'),
      openedBy: row.openedBy,
      openedAt: row.openedAt,
      closedBy: row.closedBy,
      closedAt: row.closedAt,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
      closureReason: note(row.closureReason),
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function oneOf<T extends string>(allowed: readonly string[], value: string, what: string): T {
  if (!allowed.includes(value)) throw new Error(`Invalid persisted ${what}`)
  return value as T
}

/**
 * A movement is written into its own table alongside the event that announces it.
 *
 * The table is the ledger balances are derived from and the event is how other modules
 * hear about it; writing both in one transaction is what stops the two disagreeing.
 */
async function publish(tx: Transaction, tenantId: string, event: DomainEvent): Promise<void> {
  if (event.tenantId !== tenantId) throw new Error('Event tenant does not match transaction')
  if (event instanceof InventoryStockMovedEvent) {
    const movement = event.movementOf()
    await tx.insert(schema.stockMovements).values({
      id: movement.movementId,
      tenantId,
      balanceId: event.aggregateId.toString(),
      itemId: movement.itemId,
      warehouseId: movement.warehouseId,
      kind: movement.kind,
      quantity: movement.quantity.micros,
      balanceAfter: movement.balanceAfter.micros,
      unitCost: movement.unitCost?.amount ?? null,
      currency: movement.unitCost?.currency.value ?? null,
      averageAfter: movement.averageAfter?.amount ?? null,
      balanceVersion: movement.balanceVersion,
      reason: movement.origin?.reason ?? null,
      documentType: movement.origin?.document.type ?? null,
      documentId: movement.origin?.document.id ?? null,
      occurredAt: event.occurredAt,
    })
    if (movement.lots.length > 0)
      await tx.insert(schema.stockMovementLots).values(
        movement.lots.map((lot) => ({
          tenantId,
          movementId: movement.movementId,
          lotCode: lot.code.value,
          quantity: lot.quantity.micros,
          expiresOn: lot.expiresOn?.value ?? null,
        })),
      )
  }
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
        sql`select pg_advisory_xact_lock(hashtextextended(${`inventory.audit:${tenantId}`}, 0))`,
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

async function findTracking(tx: Transaction, itemId: string): Promise<ItemTracking> {
  const [row] = await tx
    .select()
    .from(schema.itemTracking)
    .where(eq(schema.itemTracking.itemId, itemId))
    .limit(1)
  return mapTracking(row)
}

async function trackingFor(
  tx: Transaction,
  itemIds: readonly string[],
): Promise<Map<string, ItemTracking>> {
  const rows = await tx
    .select()
    .from(schema.itemTracking)
    .where(inArray(schema.itemTracking.itemId, [...itemIds]))
  return new Map(rows.map((row) => [row.itemId, mapTracking(row)]))
}

function lotsOf(tx: Transaction, balanceIds: readonly string[]) {
  return tx
    .select()
    .from(schema.stockLots)
    .where(inArray(schema.stockLots.balanceId, [...balanceIds]))
}

/**
 * The lot book, written back as it now stands.
 *
 * Replacing the rows wholesale rather than tracking which ones moved: a book has at most
 * a handful of open lots, the aggregate is already locked, and the alternative is a
 * second bookkeeping of changes that could drift from the first. Lots that have run out
 * are gone, which is what the deferred trigger checks the remainder against.
 */
async function writeLots(
  tx: Transaction,
  tenantId: string,
  balanceId: string,
  lots: readonly LotHolding[],
): Promise<void> {
  const present = lots.map((lot) => lot.code.value)
  await tx
    .delete(schema.stockLots)
    .where(
      present.length === 0
        ? eq(schema.stockLots.balanceId, balanceId)
        : and(
            eq(schema.stockLots.balanceId, balanceId),
            notInArray(schema.stockLots.lotCode, present),
          ),
    )
  for (const lot of lots)
    await tx
      .insert(schema.stockLots)
      .values({
        tenantId,
        balanceId,
        lotCode: lot.code.value,
        onHand: lot.onHand.micros,
        expiresOn: lot.expiresOn?.value ?? null,
        firstReceivedAt: lot.firstReceivedAt,
      })
      .onConflictDoUpdate({
        target: [schema.stockLots.tenantId, schema.stockLots.balanceId, schema.stockLots.lotCode],
        set: { onHand: lot.onHand.micros },
      })
}

export function makeScope(tx: Transaction, tenantId: string): InventoryScope {
  const assertTenant = (actual: string) => {
    if (actual !== tenantId) throw new Error('Aggregate tenant does not match transaction')
  }
  return {
    tenantId,
    warehouses: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.warehouses)
          .where(eq(schema.warehouses.id, id))
          .limit(1)
          .for('no key update')
        return row ? mapWarehouse(row) : null
      },
      findByName: async (name) => {
        const [row] = await tx
          .select()
          .from(schema.warehouses)
          .where(eq(schema.warehouses.name, name))
          .limit(1)
        return row ? mapWarehouse(row) : null
      },
      create: async (warehouse) => {
        const row = warehouse.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.warehouses).values({
          id: row.id,
          tenantId,
          name: row.name,
          active: row.active ? 1 : 0,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
      },
      save: async (warehouse) => {
        const row = warehouse.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.warehouses)
          .set({ name: row.name, active: row.active ? 1 : 0, updatedAt: row.updatedAt })
          .where(eq(schema.warehouses.id, row.id))
      },
    },
    balances: {
      lock: async (itemId, warehouseId) => {
        const [row] = await tx
          .select()
          .from(schema.stockBalances)
          .where(
            and(
              eq(schema.stockBalances.itemId, itemId),
              eq(schema.stockBalances.warehouseId, warehouseId),
            ),
          )
          .limit(1)
          .for('update')
        if (!row) return null
        const [tracking, lots] = await Promise.all([findTracking(tx, itemId), lotsOf(tx, [row.id])])
        return mapBalance(row, tracking, lots)
      },
      inWarehouse: async (warehouseId, itemIds) => {
        const rows = await tx
          .select()
          .from(schema.stockBalances)
          .where(
            itemIds
              ? and(
                  eq(schema.stockBalances.warehouseId, warehouseId),
                  inArray(schema.stockBalances.itemId, [...itemIds]),
                )
              : eq(schema.stockBalances.warehouseId, warehouseId),
          )
          .orderBy(asc(schema.stockBalances.itemId))
        if (rows.length === 0) return []
        const lots = await lotsOf(
          tx,
          rows.map((row) => row.id),
        )
        const tracked = await trackingFor(
          tx,
          rows.map((row) => row.itemId),
        )
        return rows.map((row) =>
          mapBalance(
            row,
            tracked.get(row.itemId) ?? UNTRACKED,
            lots.filter((lot) => lot.balanceId === row.id),
          ),
        )
      },
      create: async (balance) => {
        const row = balance.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.stockBalances).values({
          id: row.id,
          tenantId,
          itemId: row.itemId,
          warehouseId: row.warehouseId,
          onHand: micros(row.onHand),
          reserved: micros(row.reserved),
          averageUnitCost: row.averageUnitCost ? BigInt(row.averageUnitCost.amount) : null,
          currency: row.averageUnitCost?.currency ?? null,
          version: row.version,
          updatedAt: row.updatedAt,
        })
        await writeLots(tx, tenantId, row.id, balance.lots())
      },
      save: async (balance) => {
        const row = balance.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.stockBalances)
          .set({
            onHand: micros(row.onHand),
            reserved: micros(row.reserved),
            averageUnitCost: row.averageUnitCost ? BigInt(row.averageUnitCost.amount) : null,
            currency: row.averageUnitCost?.currency ?? null,
            version: row.version,
            updatedAt: row.updatedAt,
          })
          .where(eq(schema.stockBalances.id, row.id))
        await writeLots(tx, tenantId, row.id, balance.lots())
      },
    },
    movements: {
      lotsShippedFor: async (orderId: string) => {
        const rows = await tx
          .select({
            itemId: schema.stockMovements.itemId,
            lotCode: schema.stockMovementLots.lotCode,
            expiresOn: schema.stockMovementLots.expiresOn,
            kind: schema.stockMovements.kind,
            quantity: schema.stockMovementLots.quantity,
          })
          .from(schema.stockMovementLots)
          .innerJoin(
            schema.stockMovements,
            eq(schema.stockMovements.id, schema.stockMovementLots.movementId),
          )
          .where(
            and(
              eq(schema.stockMovements.documentType, 'order'),
              eq(schema.stockMovements.documentId, orderId),
            ),
          )
        return outstandingByItem(
          rows.map((row) => ({
            itemId: row.itemId,
            code: restored(LotCode.create(row.lotCode)),
            expiresOn: row.expiresOn === null ? null : restored(ExpiryDate.create(row.expiresOn)),
            quantity: Quantity.fromMicros(row.quantity),
            outbound: row.kind === 'shipment',
          })),
        )
      },
    },
    tracking: {
      find: async (itemId) => {
        const [row] = await tx
          .select()
          .from(schema.itemTracking)
          .where(eq(schema.itemTracking.itemId, itemId))
          .limit(1)
        return row
          ? {
              tenantId: row.tenantId,
              itemId: row.itemId,
              tracking: mapTracking(row),
              updatedBy: row.updatedBy,
              updatedAt: row.updatedAt,
            }
          : null
      },
      list: async () => {
        const rows = await tx
          .select()
          .from(schema.itemTracking)
          .orderBy(asc(schema.itemTracking.itemId))
        return rows.map((row) => ({
          tenantId: row.tenantId,
          itemId: row.itemId,
          tracking: mapTracking(row),
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt,
        }))
      },
      /** Anything at all on any shelf, which is what forbids the decision changing. */
      holdsStock: async (itemId) => {
        const [row] = await tx
          .select({ onHand: schema.stockBalances.onHand })
          .from(schema.stockBalances)
          .where(and(eq(schema.stockBalances.itemId, itemId), gt(schema.stockBalances.onHand, 0n)))
          .limit(1)
        return row !== undefined
      },
      save: async (item: TrackedItem) => {
        assertTenant(item.tenantId)
        await tx
          .insert(schema.itemTracking)
          .values({
            tenantId,
            itemId: item.itemId,
            tracking: item.tracking.kind,
            expiry: item.tracking.expiry,
            updatedBy: item.updatedBy,
            updatedAt: item.updatedAt,
          })
          .onConflictDoUpdate({
            target: [schema.itemTracking.tenantId, schema.itemTracking.itemId],
            set: {
              tracking: item.tracking.kind,
              expiry: item.tracking.expiry,
              updatedBy: item.updatedBy,
              updatedAt: item.updatedAt,
            },
          })
      },
    },
    reservations: {
      findByOrderId: async (orderId) => {
        const [row] = await tx
          .select()
          .from(schema.stockReservations)
          .where(eq(schema.stockReservations.orderId, orderId))
          .limit(1)
        if (!row) return null
        const lines = await tx
          .select()
          .from(schema.stockReservationLines)
          .where(eq(schema.stockReservationLines.reservationId, row.id))
        return mapReservation(row, lines)
      },
      create: async (reservation) => {
        const row = reservation.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.stockReservations).values({
          id: row.id,
          tenantId,
          orderId: row.orderId,
          orderVersion: row.orderVersion,
          status: row.status,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
        await tx.insert(schema.stockReservationLines).values(
          row.lines.map((line) => ({
            tenantId,
            reservationId: row.id,
            lineId: line.lineId,
            itemId: line.itemId,
            warehouseId: line.warehouseId,
            quantity: micros(line.quantity),
            shipped: micros(line.shipped),
          })),
        )
      },
      save: async (reservation) => {
        const row = reservation.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.stockReservations)
          .set({ orderVersion: row.orderVersion, status: row.status, updatedAt: row.updatedAt })
          .where(eq(schema.stockReservations.id, row.id))
        // What has left moves line by line, because a delivery is rarely the whole order.
        for (const line of row.lines)
          await tx
            .update(schema.stockReservationLines)
            .set({ shipped: micros(line.shipped) })
            .where(
              and(
                eq(schema.stockReservationLines.reservationId, row.id),
                eq(schema.stockReservationLines.lineId, line.lineId),
              ),
            )
      },
    },
    transfers: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.stockTransfers)
          .where(eq(schema.stockTransfers.id, id))
          .limit(1)
        if (!row) return null
        const lines = await tx
          .select()
          .from(schema.stockTransferLines)
          .where(eq(schema.stockTransferLines.transferId, row.id))
          .orderBy(asc(schema.stockTransferLines.itemId))
        return mapTransfer(row, lines)
      },
      create: async (transfer) => {
        const row = transfer.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.stockTransfers).values({
          id: row.id,
          tenantId,
          sourceWarehouseId: row.sourceWarehouseId,
          destinationWarehouseId: row.destinationWarehouseId,
          note: row.note,
          movedBy: row.movedBy,
          movedAt: row.movedAt,
        })
        await tx.insert(schema.stockTransferLines).values(
          row.lines.map((line) => ({
            tenantId,
            transferId: row.id,
            itemId: line.itemId,
            quantity: micros(line.quantity),
          })),
        )
      },
    },
    adjustments: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.stockAdjustments)
          .where(eq(schema.stockAdjustments.id, id))
          .limit(1)
          .for('update')
        return row ? mapAdjustment(row) : null
      },
      create: async (adjustment) => {
        const row = adjustment.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.stockAdjustments).values({
          lotCode: row.lot,
          id: row.id,
          tenantId,
          warehouseId: row.warehouseId,
          itemId: row.itemId,
          direction: row.direction,
          quantity: micros(row.quantity),
          reason: row.reason,
          note: row.note,
          statedUnitCost: row.statedUnitCost ? BigInt(row.statedUnitCost.amount) : null,
          statedCurrency: row.statedUnitCost?.currency ?? null,
          value: row.value ? BigInt(row.value.amount) : null,
          valueCurrency: row.value?.currency ?? null,
          status: row.status,
          approvalState: row.approvalState,
          requestedBy: row.requestedBy,
          requestedAt: row.requestedAt,
          decidedBy: row.decidedBy,
          decidedAt: row.decidedAt,
          decisionReason: row.decisionReason,
          postedAt: row.postedAt,
          updatedAt: row.updatedAt,
        })
      },
      save: async (adjustment) => {
        const row = adjustment.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.stockAdjustments)
          .set({
            status: row.status,
            approvalState: row.approvalState,
            decidedBy: row.decidedBy,
            decidedAt: row.decidedAt,
            decisionReason: row.decisionReason,
            postedAt: row.postedAt,
            updatedAt: row.updatedAt,
          })
          .where(eq(schema.stockAdjustments.id, row.id))
      },
    },
    counts: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.stockCounts)
          .where(eq(schema.stockCounts.id, id))
          .limit(1)
          .for('update')
        if (!row) return null
        const lines = await tx
          .select()
          .from(schema.stockCountLines)
          .where(eq(schema.stockCountLines.countId, row.id))
          .orderBy(asc(schema.stockCountLines.itemId))
        return mapCount(row, lines)
      },
      create: async (count) => {
        const row = count.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.stockCounts).values({
          id: row.id,
          tenantId,
          warehouseId: row.warehouseId,
          note: row.note,
          status: row.status,
          approvalState: row.approvalState,
          openedBy: row.openedBy,
          openedAt: row.openedAt,
          closedBy: row.closedBy,
          closedAt: row.closedAt,
          decidedBy: row.decidedBy,
          decidedAt: row.decidedAt,
          closureReason: row.closureReason,
          updatedAt: row.updatedAt,
        })
        await tx.insert(schema.stockCountLines).values(
          row.lines.map((line) => ({
            id: new UniqueEntityID().toString(),
            tenantId,
            countId: row.id,
            itemId: line.itemId,
            lotCode: line.lot,
            expected: micros(line.expected),
            counted: line.counted === null ? null : micros(line.counted),
          })),
        )
      },
      save: async (count) => {
        const row = count.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.stockCounts)
          .set({
            status: row.status,
            approvalState: row.approvalState,
            closedBy: row.closedBy,
            closedAt: row.closedAt,
            decidedBy: row.decidedBy,
            decidedAt: row.decidedAt,
            closureReason: row.closureReason,
            updatedAt: row.updatedAt,
          })
          .where(eq(schema.stockCounts.id, row.id))
        // Figures are only ever written while the sheet is open; a trigger says so too,
        // so writing them here after it closed would abort the transaction.
        if (row.status !== 'open') return
        for (const line of row.lines)
          await tx
            .update(schema.stockCountLines)
            .set({ counted: line.counted === null ? null : micros(line.counted) })
            .where(
              and(
                eq(schema.stockCountLines.countId, row.id),
                eq(schema.stockCountLines.itemId, line.itemId),
                line.lot === null
                  ? isNull(schema.stockCountLines.lotCode)
                  : eq(schema.stockCountLines.lotCode, line.lot),
              ),
            )
      },
    },
    policies: {
      find: async (currency) => {
        const [row] = await tx
          .select()
          .from(schema.adjustmentPolicies)
          .where(eq(schema.adjustmentPolicies.currency, currency))
          .limit(1)
        return row ? mapPolicy(row) : null
      },
      list: async () => {
        const rows = await tx
          .select()
          .from(schema.adjustmentPolicies)
          .orderBy(asc(schema.adjustmentPolicies.currency))
        return rows.map(mapPolicy)
      },
      save: async (policy: AdjustmentPolicy) => {
        assertTenant(policy.tenantId)
        await tx
          .insert(schema.adjustmentPolicies)
          .values({ ...policy, tenantId })
          .onConflictDoUpdate({
            target: [schema.adjustmentPolicies.tenantId, schema.adjustmentPolicies.currency],
            set: {
              threshold: policy.threshold,
              updatedBy: policy.updatedBy,
              updatedAt: policy.updatedAt,
            },
          })
      },
    },
    levels: {
      save: async (level: StockLevel) => {
        assertTenant(level.tenantId)
        await tx
          .insert(schema.stockLevels)
          .values({ ...level, tenantId })
          .onConflictDoUpdate({
            target: [
              schema.stockLevels.tenantId,
              schema.stockLevels.warehouseId,
              schema.stockLevels.itemId,
            ],
            set: {
              minimum: level.minimum,
              maximum: level.maximum,
              updatedBy: level.updatedBy,
              updatedAt: level.updatedAt,
            },
          })
      },
    },
    events: { append: (event) => publish(tx, tenantId, event) },
    audit: auditTrail(tx, tenantId),
  }
}

function mapPolicy(row: typeof schema.adjustmentPolicies.$inferSelect): AdjustmentPolicy {
  return {
    tenantId: row.tenantId,
    currency: row.currency,
    threshold: row.threshold,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  }
}
