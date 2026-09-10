import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomUUID } from 'node:crypto'
import { context, trace } from '@opentelemetry/api'
import { and, asc, eq, gt, or, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { type TenantScope, UnitOfWork } from '@/application/ports/unit-of-work'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import type { Page } from '@/core/repositories/pagination-params'
import { CatalogItem } from '@/domain/entities/catalog-item'
import { PriceList } from '@/domain/entities/price-list'
import { UnitOfMeasure } from '@/domain/entities/unit-of-measure'
import {
  CatalogName,
  Currency,
  NcmCode,
  Sku,
  UnitCode,
} from '@/domain/value-objects/catalog-values'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type Cursor = { createdAt: string; id: string }

export interface CatalogDatabaseOptions {
  readonly url: string
  readonly poolMax?: number
  readonly statementTimeoutMs?: number
}

export interface ReceivedEvent {
  readonly sourceModule: string
  readonly eventId: string
  readonly eventType: string
}

export class CatalogDatabase extends UnitOfWork {
  readonly #client: ReturnType<typeof postgres>
  readonly #db: Database
  readonly #transactions = new AsyncLocalStorage<{ tx: Transaction; tenantId: string }>()

  constructor(options: CatalogDatabaseOptions) {
    super()
    this.#client = postgres(options.url, {
      max: options.poolMax ?? 10,
      connect_timeout: 5,
      connection: { statement_timeout: options.statementTimeoutMs ?? 5000 },
    })
    this.#db = drizzle(this.#client, { schema })
  }

  async inTenant<T>(tenantId: string, work: (scope: TenantScope) => Promise<T>): Promise<T> {
    if (this.#transactions.getStore())
      throw new Error('Nested tenant transactions are not supported')
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`)
      return this.#transactions.run({ tx, tenantId }, () => work(makeScope(tx, tenantId)))
    })
  }

  async provisionTenant(tenantId: string): Promise<void> {
    await this.inTenant(tenantId, async () => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Tenant provisioning requires a transaction')
      await current.tx.insert(schema.tenants).values({ id: tenantId }).onConflictDoNothing()
    })
  }

  async processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: TenantScope) => Promise<T>,
  ): Promise<{ processed: false } | { processed: true; value: T }> {
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
  async close(): Promise<void> {
    await this.#client.end({ timeout: 5 })
  }
}

function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted catalog value', { cause: result.value })
  return result.value
}

function mapUnit(row: typeof schema.units.$inferSelect): UnitOfMeasure {
  return UnitOfMeasure.create(
    {
      tenantId: row.tenantId,
      code: restored(UnitCode.create(row.code)),
      name: restored(CatalogName.create(row.name)),
      decimalPlaces: row.decimalPlaces,
      active: row.active === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapItem(row: typeof schema.catalogItems.$inferSelect): CatalogItem {
  if (row.kind !== 'product' && row.kind !== 'service')
    throw new Error('Invalid persisted catalog item kind')
  return CatalogItem.create(
    {
      tenantId: row.tenantId,
      kind: row.kind,
      sku: restored(Sku.create(row.sku)),
      name: restored(CatalogName.create(row.name)),
      unitId: row.unitId,
      ncm: row.ncm === null ? null : restored(NcmCode.create(row.ncm)),
      active: row.active === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapPriceList(
  row: typeof schema.priceLists.$inferSelect,
  rows: readonly (typeof schema.prices.$inferSelect)[],
): PriceList {
  return PriceList.create(
    {
      tenantId: row.tenantId,
      name: restored(CatalogName.create(row.name)),
      currency: restored(Currency.create(row.currency)),
      prices: new Map(rows.map((price) => [price.itemId, price.amount])),
      active: row.active === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
  ).toString('base64url')
}

function decodeCursor(value: string | undefined): Cursor | null {
  if (value === undefined) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null
    if (Number.isNaN(new Date(parsed.createdAt).valueOf())) return null
    return { createdAt: parsed.createdAt, id: parsed.id }
  } catch {
    return null
  }
}

function page<T>(items: readonly T[], limit: number, cursorOf: (item: T) => string): Page<T> {
  const hasMore = items.length > limit
  const visible = items.slice(0, limit)
  const last = visible.at(-1)
  return { items: visible, hasMore, ...(hasMore && last ? { nextCursor: cursorOf(last) } : {}) }
}

function after(createdAt: AnyPgColumn, id: AnyPgColumn, cursor: Cursor | null) {
  if (!cursor) return undefined
  const occurred = new Date(cursor.createdAt)
  return or(gt(createdAt, occurred), and(eq(createdAt, occurred), gt(id, cursor.id)))
}

async function publish(
  tx: Transaction,
  tenantId: string,
  events: readonly DomainEvent[],
): Promise<void> {
  for (const event of events) {
    if (event.tenantId !== tenantId) throw new Error('Event tenant does not match transaction')
    const span = trace.getSpan(context.active())?.spanContext()
    await tx.insert(schema.outbox).values({
      id: randomUUID(),
      eventId: randomUUID(),
      tenantId,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      occurredAt: event.occurredAt,
      traceId: span?.traceId ?? randomBytes(16).toString('hex'),
      traceParent: span
        ? `00-${span.traceId}-${span.spanId}-${span.traceFlags.toString(16).padStart(2, '0')}`
        : null,
      payload: event.payloadOf(),
    })
  }
}

function makeScope(tx: Transaction, tenantId: string): TenantScope {
  const assertTenant = (actual: string) => {
    if (actual !== tenantId) throw new Error('Aggregate tenant does not match transaction')
  }
  const units: TenantScope['units'] = {
    findById: async (id) => {
      const [row] = await tx.select().from(schema.units).where(eq(schema.units.id, id)).limit(1)
      return row ? mapUnit(row) : null
    },
    findByCode: async (code) => {
      const [row] = await tx.select().from(schema.units).where(eq(schema.units.code, code)).limit(1)
      return row ? mapUnit(row) : null
    },
    create: async (unit) => {
      const row = unit.toSnapshot()
      assertTenant(row.tenantId)
      await tx.insert(schema.units).values({ ...row, active: row.active ? 1 : 0 })
    },
    save: async (unit) => {
      const row = unit.toSnapshot()
      assertTenant(row.tenantId)
      await tx
        .update(schema.units)
        .set({
          name: row.name,
          decimalPlaces: row.decimalPlaces,
          active: row.active ? 1 : 0,
          updatedAt: row.updatedAt,
        })
        .where(eq(schema.units.id, row.id))
      await publish(tx, tenantId, unit.pullDomainEvents())
    },
    list: async (params) => {
      const rows = await tx
        .select()
        .from(schema.units)
        .where(after(schema.units.createdAt, schema.units.id, decodeCursor(params.cursor)))
        .orderBy(asc(schema.units.createdAt), asc(schema.units.id))
        .limit(params.limit + 1)
      return page(rows.map(mapUnit), params.limit, (unit) => {
        const row = unit.toSnapshot()
        return encodeCursor(row)
      })
    },
  }
  const items: TenantScope['items'] = {
    findById: async (id) => {
      const [row] = await tx
        .select()
        .from(schema.catalogItems)
        .where(eq(schema.catalogItems.id, id))
        .limit(1)
      return row ? mapItem(row) : null
    },
    findBySku: async (sku) => {
      const [row] = await tx
        .select()
        .from(schema.catalogItems)
        .where(eq(schema.catalogItems.sku, sku))
        .limit(1)
      return row ? mapItem(row) : null
    },
    create: async (item) => {
      const row = item.toSnapshot()
      assertTenant(row.tenantId)
      await tx.insert(schema.catalogItems).values({ ...row, active: row.active ? 1 : 0 })
      await publish(tx, tenantId, item.pullDomainEvents())
    },
    save: async (item) => {
      const row = item.toSnapshot()
      assertTenant(row.tenantId)
      await tx
        .update(schema.catalogItems)
        .set({
          name: row.name,
          unitId: row.unitId,
          ncm: row.ncm,
          active: row.active ? 1 : 0,
          updatedAt: row.updatedAt,
        })
        .where(eq(schema.catalogItems.id, row.id))
      await publish(tx, tenantId, item.pullDomainEvents())
    },
    list: async (params) => {
      const rows = await tx
        .select()
        .from(schema.catalogItems)
        .where(
          after(schema.catalogItems.createdAt, schema.catalogItems.id, decodeCursor(params.cursor)),
        )
        .orderBy(asc(schema.catalogItems.createdAt), asc(schema.catalogItems.id))
        .limit(params.limit + 1)
      return page(rows.map(mapItem), params.limit, (item) => encodeCursor(item.toSnapshot()))
    },
  }
  const priceLists: TenantScope['priceLists'] = {
    findById: async (id) => {
      const [row] = await tx
        .select()
        .from(schema.priceLists)
        .where(eq(schema.priceLists.id, id))
        .limit(1)
      if (!row) return null
      const priceRows = await tx
        .select()
        .from(schema.prices)
        .where(eq(schema.prices.priceListId, id))
      return mapPriceList(row, priceRows)
    },
    findByName: async (name) => {
      const [row] = await tx
        .select()
        .from(schema.priceLists)
        .where(eq(schema.priceLists.name, name))
        .limit(1)
      if (!row) return null
      const priceRows = await tx
        .select()
        .from(schema.prices)
        .where(eq(schema.prices.priceListId, row.id))
      return mapPriceList(row, priceRows)
    },
    create: async (list) => {
      const row = list.toSnapshot()
      assertTenant(row.tenantId)
      await tx.insert(schema.priceLists).values({
        id: row.id,
        tenantId,
        name: row.name,
        currency: row.currency,
        active: row.active ? 1 : 0,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
    },
    save: async (list) => {
      const row = list.toSnapshot()
      assertTenant(row.tenantId)
      await tx
        .update(schema.priceLists)
        .set({ name: row.name, active: row.active ? 1 : 0, updatedAt: row.updatedAt })
        .where(eq(schema.priceLists.id, row.id))
      for (const price of row.prices)
        await tx
          .insert(schema.prices)
          .values({
            tenantId,
            priceListId: row.id,
            itemId: price.itemId,
            amount: BigInt(price.amount),
            updatedAt: row.updatedAt,
          })
          .onConflictDoUpdate({
            target: [schema.prices.tenantId, schema.prices.priceListId, schema.prices.itemId],
            set: { amount: BigInt(price.amount), updatedAt: row.updatedAt },
          })
      await publish(tx, tenantId, list.pullDomainEvents())
    },
    list: async (params) => {
      const rows = await tx
        .select()
        .from(schema.priceLists)
        .where(
          after(schema.priceLists.createdAt, schema.priceLists.id, decodeCursor(params.cursor)),
        )
        .orderBy(asc(schema.priceLists.createdAt), asc(schema.priceLists.id))
        .limit(params.limit + 1)
      const lists = await Promise.all(
        rows.map(async (row) =>
          mapPriceList(
            row,
            await tx.select().from(schema.prices).where(eq(schema.prices.priceListId, row.id)),
          ),
        ),
      )
      return page(lists, params.limit, (list) => encodeCursor(list.toSnapshot()))
    },
  }
  return { tenantId, units, items, priceLists }
}
