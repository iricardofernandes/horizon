import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import {
  SERVICE_DELIVERY_STATUSES,
  SERVICE_ORDER_STATUSES,
  type ServiceDelivery,
  type ServiceDeliveryStatus,
  ServiceOrder,
  type ServiceOrderStatus,
} from '@/domain/entities/service-order'
import type { ServiceOrdersRepository } from '@/domain/repositories/sales-repositories'
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
type Snapshot = ReturnType<ServiceOrder['toSnapshot']>

/** The service orders of the tenant the transaction is scoped to (Phase 50). */
export function serviceOrdersRepository(
  tx: Transaction,
  tenantId: string,
  publish: (order: ServiceOrder) => Promise<void>,
): ServiceOrdersRepository {
  const assertTenant = (actual: string) => {
    if (actual !== tenantId) throw new Error('Aggregate tenant does not match transaction')
  }
  return {
    findById: async (id) => loadServiceOrder(tx, id, true),
    create: async (order) => {
      const row = order.toSnapshot()
      assertTenant(row.tenantId)
      await tx.insert(schema.serviceOrders).values(orderRow(row))
      await tx.insert(schema.serviceOrderLines).values(
        row.lines.map((line, position) => ({
          tenantId,
          serviceOrderId: row.id,
          lineId: line.lineId,
          itemId: line.itemId,
          description: line.description,
          quantity: micros(line.quantity),
          unitPrice: BigInt(line.unitPrice),
          lineTotal: BigInt(line.lineTotal),
          delivered: micros(line.delivered),
          position,
        })),
      )
      await writeDeliveries(tx, tenantId, row, new Set())
      await publish(order)
    },
    save: async (order) => {
      const row = order.toSnapshot()
      assertTenant(row.tenantId)
      const {
        id,
        tenantId: _tenant,
        customerId: _customer,
        quoteId: _quote,
        ...changed
      } = orderRow(row)
      await tx
        .update(schema.serviceOrders)
        .set(changed)
        .where(and(eq(schema.serviceOrders.tenantId, tenantId), eq(schema.serviceOrders.id, id)))
      for (const line of row.lines)
        await tx
          .update(schema.serviceOrderLines)
          .set({ delivered: micros(line.delivered) })
          .where(
            and(
              eq(schema.serviceOrderLines.tenantId, tenantId),
              eq(schema.serviceOrderLines.serviceOrderId, row.id),
              eq(schema.serviceOrderLines.lineId, line.lineId),
            ),
          )
      const stored = await tx
        .select({ id: schema.serviceDeliveries.id, status: schema.serviceDeliveries.status })
        .from(schema.serviceDeliveries)
        .where(
          and(
            eq(schema.serviceDeliveries.tenantId, tenantId),
            eq(schema.serviceDeliveries.serviceOrderId, row.id),
          ),
        )
      const known = new Map(stored.map((delivery) => [delivery.id, delivery.status]))
      await writeDeliveries(tx, tenantId, row, new Set(known.keys()))
      for (const delivery of row.deliveries) {
        if (delivery.status !== 'cancelled' || known.get(delivery.id) !== 'active') continue
        await tx
          .update(schema.serviceDeliveries)
          .set({
            status: 'cancelled',
            cancelledBy: delivery.cancelledBy,
            cancelledOn: delivery.cancelledOn,
            cancellationReason: delivery.cancellationReason,
          })
          .where(
            and(
              eq(schema.serviceDeliveries.tenantId, tenantId),
              eq(schema.serviceDeliveries.id, delivery.id),
            ),
          )
      }
      await publish(order)
    },
  }
}

export async function listServiceOrderSnapshots(tx: Transaction): Promise<readonly Snapshot[]> {
  const rows = await tx
    .select({ id: schema.serviceOrders.id })
    .from(schema.serviceOrders)
    .orderBy(desc(schema.serviceOrders.createdAt))
    .limit(100)
  const orders = await Promise.all(rows.map((row) => loadServiceOrder(tx, row.id, false)))
  return orders.flatMap((order) => (order ? [order.toSnapshot()] : []))
}

export async function findServiceOrderSnapshot(
  tx: Transaction,
  id: string,
): Promise<Snapshot | null> {
  return (await loadServiceOrder(tx, id, false))?.toSnapshot() ?? null
}

async function loadServiceOrder(
  tx: Transaction,
  id: string,
  forUpdate: boolean,
): Promise<ServiceOrder | null> {
  const query = tx
    .select()
    .from(schema.serviceOrders)
    .where(eq(schema.serviceOrders.id, id))
    .limit(1)
  const [row] = forUpdate ? await query.for('update') : await query
  if (!row) return null
  const lines = await tx
    .select()
    .from(schema.serviceOrderLines)
    .where(eq(schema.serviceOrderLines.serviceOrderId, row.id))
    .orderBy(asc(schema.serviceOrderLines.position))
  const deliveries = await tx
    .select()
    .from(schema.serviceDeliveries)
    .where(eq(schema.serviceDeliveries.serviceOrderId, row.id))
    .orderBy(asc(schema.serviceDeliveries.createdAt), asc(schema.serviceDeliveries.id))
  const entries =
    deliveries.length === 0
      ? []
      : await tx
          .select()
          .from(schema.serviceDeliveryLines)
          .where(
            inArray(
              schema.serviceDeliveryLines.deliveryId,
              deliveries.map((delivery) => delivery.id),
            ),
          )
          .orderBy(asc(schema.serviceDeliveryLines.position))
  return mapServiceOrder(row, lines, deliveries, entries)
}

function mapServiceOrder(
  row: typeof schema.serviceOrders.$inferSelect,
  lines: readonly (typeof schema.serviceOrderLines.$inferSelect)[],
  deliveries: readonly (typeof schema.serviceDeliveries.$inferSelect)[],
  entries: readonly (typeof schema.serviceDeliveryLines.$inferSelect)[],
): ServiceOrder {
  const currency = restored(Currency.create(row.currency))
  const money = (amount: bigint) => Money.fromAmount(amount, currency)
  const line = (entry: {
    lineId: string
    itemId: string
    description: string
    quantity: bigint
    unitPrice: bigint
    lineTotal: bigint
  }) => ({
    lineId: entry.lineId,
    itemId: entry.itemId,
    description: restored(LineDescription.create(entry.description)),
    quantity: Quantity.fromMicros(entry.quantity),
    unitPrice: money(entry.unitPrice),
    lineTotal: money(entry.lineTotal),
  })
  return ServiceOrder.rehydrate(
    {
      tenantId: row.tenantId,
      customerId: row.customerId,
      quoteId: row.quoteId,
      currency,
      lines: lines.map(line),
      discount: money(row.discount),
      paymentTerms: restored(PaymentTerms.create(row.paymentTermDays)),
      notes: row.notes,
      scheduledFor: row.scheduledFor ? restored(BusinessDate.create(row.scheduledFor)) : null,
      openedOn: restored(BusinessDate.create(row.openedOn)),
      status: oneOf<ServiceOrderStatus>(SERVICE_ORDER_STATUSES, row.status),
      deliveries: deliveries.map(
        (delivery): ServiceDelivery => ({
          id: delivery.id,
          performedOn: restored(BusinessDate.create(delivery.performedOn)),
          value: money(delivery.value),
          deliveredBy: delivery.deliveredBy,
          status: oneOf<ServiceDeliveryStatus>(SERVICE_DELIVERY_STATUSES, delivery.status),
          cancellation:
            delivery.cancelledBy && delivery.cancelledOn && delivery.cancellationReason
              ? {
                  by: delivery.cancelledBy,
                  on: restored(BusinessDate.create(delivery.cancelledOn)),
                  reason: restored(Reason.create(delivery.cancellationReason)),
                }
              : null,
          createdAt: delivery.createdAt,
          entries: entries
            .filter((entry) => entry.deliveryId === delivery.id)
            .map((entry) => ({
              ...line(entry),
              entryId: entry.entryId,
              amount: money(entry.amount),
            })),
        }),
      ),
      createdBy: row.createdBy,
      acceptedBy: row.acceptedBy,
      closure: row.closureReason ? restored(Reason.create(row.closureReason)) : null,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function orderRow(row: Snapshot) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    customerId: row.customerId,
    quoteId: row.quoteId,
    status: row.status,
    currency: row.currency,
    net: BigInt(row.net),
    discount: BigInt(row.discount),
    total: BigInt(row.total),
    billed: BigInt(row.billed),
    paymentTermDays: [...row.paymentTermDays],
    notes: row.notes,
    scheduledFor: row.scheduledFor,
    openedOn: row.openedOn,
    createdBy: row.createdBy,
    acceptedBy: row.acceptedBy,
    closureReason: row.closureReason,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Inserts the deliveries not stored yet; a stored delivery's facts are never rewritten. */
async function writeDeliveries(
  tx: Transaction,
  tenantId: string,
  row: Snapshot,
  stored: ReadonlySet<string>,
): Promise<void> {
  for (const delivery of row.deliveries) {
    if (stored.has(delivery.id)) continue
    await tx.insert(schema.serviceDeliveries).values({
      id: delivery.id,
      tenantId,
      serviceOrderId: row.id,
      performedOn: delivery.performedOn,
      value: BigInt(delivery.value),
      currency: row.currency,
      deliveredBy: delivery.deliveredBy,
      status: delivery.status,
      cancelledBy: delivery.cancelledBy,
      cancelledOn: delivery.cancelledOn,
      cancellationReason: delivery.cancellationReason,
      createdAt: delivery.createdAt,
    })
    await tx.insert(schema.serviceDeliveryLines).values(
      delivery.entries.map((entry, position) => ({
        tenantId,
        deliveryId: delivery.id,
        entryId: entry.entryId,
        lineId: entry.lineId,
        itemId: entry.itemId,
        description: entry.description,
        quantity: micros(entry.quantity),
        unitPrice: BigInt(entry.unitPrice),
        lineTotal: BigInt(entry.lineTotal),
        amount: BigInt(entry.amount),
        position,
      })),
    )
  }
}

function micros(quantity: string): bigint {
  return restored(Quantity.create(quantity)).micros
}

function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted service order')
  return result.value
}

function oneOf<T extends string>(allowed: readonly T[], value: string): T {
  if (!allowed.includes(value as T)) throw new Error('Invalid persisted service order status')
  return value as T
}
