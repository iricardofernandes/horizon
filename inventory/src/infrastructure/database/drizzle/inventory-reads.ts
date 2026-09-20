import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { Quantity } from '@/domain/value-objects/inventory-values'
import type { Transaction } from './inventory-store'
import * as schema from './schema'

/**
 * Read models, kept apart from the write side.
 *
 * Nothing here loads an aggregate: a screen asking what is on a shelf has no business
 * rehydrating an entity and no need for one, and a query written as a projection stays
 * a single statement instead of becoming N of them.
 */

export interface Page {
  readonly limit: number
  readonly offset: number
}

const quantity = (value: bigint) => Quantity.fromMicros(value).toString()
const money = (amount: bigint | null, currency: string | null) =>
  amount === null || currency === null ? null : { amount: amount.toString(), currency }

export async function listWarehouses(tx: Transaction) {
  const warehouses = await tx.select().from(schema.warehouses).orderBy(asc(schema.warehouses.name))
  const balances = await tx.select().from(schema.stockBalances)
  return warehouses.map((warehouse) => ({
    id: warehouse.id,
    name: warehouse.name,
    active: warehouse.active === 1,
    balances: balances
      .filter((balance) => balance.warehouseId === warehouse.id)
      .map((balance) => ({
        itemId: balance.itemId,
        onHand: quantity(balance.onHand),
        reserved: quantity(balance.reserved),
        available: quantity(balance.onHand - balance.reserved),
        averageUnitCost: money(balance.averageUnitCost, balance.currency),
      })),
  }))
}

export async function listTransfers(tx: Transaction, page: Page) {
  const rows = await tx
    .select()
    .from(schema.stockTransfers)
    .orderBy(desc(schema.stockTransfers.movedAt))
    .limit(page.limit)
    .offset(page.offset)
  if (rows.length === 0) return []
  const lines = await tx
    .select()
    .from(schema.stockTransferLines)
    .where(
      inArray(
        schema.stockTransferLines.transferId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(schema.stockTransferLines.itemId))
  return rows.map((row) => ({
    id: row.id,
    sourceWarehouseId: row.sourceWarehouseId,
    destinationWarehouseId: row.destinationWarehouseId,
    note: row.note,
    movedBy: row.movedBy,
    movedAt: row.movedAt.toISOString(),
    lines: lines
      .filter((line) => line.transferId === row.id)
      .map((line) => ({ itemId: line.itemId, quantity: quantity(line.quantity) })),
  }))
}

export async function listAdjustments(
  tx: Transaction,
  filter: { status: string | null; warehouseId: string | null } & Page,
) {
  const conditions = [
    filter.status ? eq(schema.stockAdjustments.status, filter.status) : undefined,
    filter.warehouseId ? eq(schema.stockAdjustments.warehouseId, filter.warehouseId) : undefined,
  ].filter((condition) => condition !== undefined)
  const rows = await tx
    .select()
    .from(schema.stockAdjustments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.stockAdjustments.requestedAt))
    .limit(filter.limit)
    .offset(filter.offset)
  return rows.map((row) => ({
    id: row.id,
    warehouseId: row.warehouseId,
    itemId: row.itemId,
    direction: row.direction,
    quantity: quantity(row.quantity),
    reason: row.reason,
    note: row.note,
    value: money(row.value, row.valueCurrency),
    status: row.status,
    approvalState: row.approvalState,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    postedAt: row.postedAt?.toISOString() ?? null,
  }))
}

export async function listCounts(
  tx: Transaction,
  filter: { status: string | null; warehouseId: string | null } & Page,
) {
  const conditions = [
    filter.status ? eq(schema.stockCounts.status, filter.status) : undefined,
    filter.warehouseId ? eq(schema.stockCounts.warehouseId, filter.warehouseId) : undefined,
  ].filter((condition) => condition !== undefined)
  const rows = await tx
    .select()
    .from(schema.stockCounts)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.stockCounts.openedAt))
    .limit(filter.limit)
    .offset(filter.offset)
  return rows.map(header)
}

export async function countDetail(tx: Transaction, id: string) {
  const [row] = await tx
    .select()
    .from(schema.stockCounts)
    .where(eq(schema.stockCounts.id, id))
    .limit(1)
  if (!row) return null
  const lines = await tx
    .select()
    .from(schema.stockCountLines)
    .where(eq(schema.stockCountLines.countId, id))
    .orderBy(asc(schema.stockCountLines.itemId))
  return {
    ...header(row),
    note: row.note,
    lines: lines.map((line) => ({
      itemId: line.itemId,
      expected: quantity(line.expected),
      counted: line.counted === null ? null : quantity(line.counted),
      // The difference is what the sheet would post, not what the balance holds now.
      variance:
        line.counted === null
          ? null
          : {
              direction: line.counted >= line.expected ? 'in' : 'out',
              quantity: quantity(
                line.counted >= line.expected
                  ? line.counted - line.expected
                  : line.expected - line.counted,
              ),
            },
    })),
  }
}

export async function listPolicies(tx: Transaction) {
  const rows = await tx
    .select()
    .from(schema.adjustmentPolicies)
    .orderBy(asc(schema.adjustmentPolicies.currency))
  return rows.map((row) => ({
    currency: row.currency,
    threshold: row.threshold.toString(),
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  }))
}

function header(row: typeof schema.stockCounts.$inferSelect) {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    status: row.status,
    approvalState: row.approvalState,
    openedBy: row.openedBy,
    openedAt: row.openedAt.toISOString(),
    closedBy: row.closedBy,
    closedAt: row.closedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    closureReason: row.closureReason,
  }
}
