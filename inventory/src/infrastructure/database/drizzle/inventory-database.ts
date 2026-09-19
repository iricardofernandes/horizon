import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { context, propagation, trace } from '@opentelemetry/api'
import { and, eq, sql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type { EventOutcome, InventoryScope, ReceivedEvent } from '@/application/ports/unit-of-work'
import { InventoryUnitOfWork } from '@/application/ports/unit-of-work'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import { StockBalance } from '@/domain/entities/stock-balance'
import { StockReservation } from '@/domain/entities/stock-reservation'
import { Warehouse } from '@/domain/entities/warehouse'
import { InventoryStockMovedEvent } from '@/domain/events/inventory-events'
import { Currency, Money, Quantity, WarehouseName } from '@/domain/value-objects/inventory-values'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface InventoryDatabaseOptions {
  readonly url: string
  readonly poolMax?: number
  readonly statementTimeoutMs?: number
}

export class InventoryDatabase extends InventoryUnitOfWork {
  readonly #client: ReturnType<typeof postgres>
  readonly #db: Database
  readonly #transactions = new AsyncLocalStorage<{ tx: Transaction; tenantId: string }>()

  constructor(options: InventoryDatabaseOptions) {
    super()
    this.#client = postgres(options.url, {
      max: options.poolMax ?? 10,
      connect_timeout: 5,
      connection: { statement_timeout: options.statementTimeoutMs ?? 5000 },
    })
    this.#db = drizzle(this.#client, { schema })
  }

  async provisionTenant(tenantId: string): Promise<void> {
    await this.inTenant(tenantId, async () => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Tenant provisioning requires a transaction')
      await current.tx.insert(schema.tenants).values({ id: tenantId }).onConflictDoNothing()
    })
  }

  async inTenant<T>(tenantId: string, work: (scope: InventoryScope) => Promise<T>): Promise<T> {
    if (this.#transactions.getStore())
      throw new Error('Nested tenant transactions are not supported')
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`)
      return this.#transactions.run({ tx, tenantId }, () => work(makeScope(tx, tenantId)))
    })
  }

  async processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: InventoryScope) => Promise<T>,
  ): Promise<EventOutcome<T>> {
    return this.inTenant(tenantId, async (scope) => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Inbox processing requires a transaction')
      const claimed = await current.tx
        .insert(schema.inbox)
        .values({ ...event, tenantId })
        .onConflictDoNothing({ target: [schema.inbox.sourceModule, schema.inbox.eventId] })
        .returning({ eventId: schema.inbox.eventId })
      if (claimed.length === 0) return { processed: false as const }
      return { processed: true as const, value: await work(scope) }
    })
  }

  async ping(): Promise<void> {
    await this.#db.execute(sql`select 1`)
  }

  async listWarehouseSnapshots(tenantId: string) {
    return this.inTenant(tenantId, async () => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Warehouse listing requires a transaction')
      const warehouseRows = await current.tx
        .select()
        .from(schema.warehouses)
        .orderBy(sql`${schema.warehouses.name} asc`)
      const balanceRows = await current.tx.select().from(schema.stockBalances)
      return warehouseRows.map((warehouse) => ({
        id: warehouse.id,
        name: warehouse.name,
        active: warehouse.active === 1,
        balances: balanceRows
          .filter((balance) => balance.warehouseId === warehouse.id)
          .map((balance) => ({
            itemId: balance.itemId,
            onHand: Quantity.fromMicros(balance.onHand).toString(),
            reserved: Quantity.fromMicros(balance.reserved).toString(),
          })),
      }))
    })
  }

  async close(): Promise<void> {
    await this.#client.end({ timeout: 5 })
  }
}

function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted inventory value', { cause: result.value })
  return result.value
}

function mapBalance(row: typeof schema.stockBalances.$inferSelect): StockBalance {
  const currency = row.currency === null ? null : restored(Currency.create(row.currency))
  return StockBalance.rehydrate(
    {
      tenantId: row.tenantId,
      itemId: row.itemId,
      warehouseId: row.warehouseId,
      onHand: Quantity.fromMicros(row.onHand),
      reserved: Quantity.fromMicros(row.reserved),
      averageUnitCost:
        row.averageUnitCost === null || currency === null
          ? null
          : Money.fromAmount(row.averageUnitCost, currency),
      version: row.version,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
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
      balanceVersion: movement.balanceVersion,
      occurredAt: event.occurredAt,
    })
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

function makeScope(tx: Transaction, tenantId: string): InventoryScope {
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
            sql`${schema.stockBalances.itemId} = ${itemId} AND ${schema.stockBalances.warehouseId} = ${warehouseId}`,
          )
          .limit(1)
          .for('update')
        return row ? mapBalance(row) : null
      },
      create: async (balance) => {
        const row = balance.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.stockBalances).values({
          id: row.id,
          tenantId,
          itemId: row.itemId,
          warehouseId: row.warehouseId,
          onHand: restored(Quantity.create(row.onHand)).micros,
          reserved: restored(Quantity.create(row.reserved)).micros,
          averageUnitCost: row.averageUnitCost ? BigInt(row.averageUnitCost.amount) : null,
          currency: row.averageUnitCost?.currency ?? null,
          version: row.version,
          updatedAt: row.updatedAt,
        })
      },
      save: async (balance) => {
        const row = balance.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.stockBalances)
          .set({
            onHand: restored(Quantity.create(row.onHand)).micros,
            reserved: restored(Quantity.create(row.reserved)).micros,
            averageUnitCost: row.averageUnitCost ? BigInt(row.averageUnitCost.amount) : null,
            currency: row.averageUnitCost?.currency ?? null,
            version: row.version,
            updatedAt: row.updatedAt,
          })
          .where(eq(schema.stockBalances.id, row.id))
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
            quantity: restored(Quantity.create(line.quantity)).micros,
            shipped: restored(Quantity.create(line.shipped)).micros,
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
            .set({ shipped: restored(Quantity.create(line.shipped)).micros })
            .where(
              and(
                eq(schema.stockReservationLines.reservationId, row.id),
                eq(schema.stockReservationLines.lineId, line.lineId),
              ),
            )
      },
    },
    events: { append: (event) => publish(tx, tenantId, event) },
  }
}
