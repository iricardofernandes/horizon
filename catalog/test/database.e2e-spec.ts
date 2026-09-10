import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { CreateCatalogItemUseCase } from '@/application/use-cases/create-catalog-item'
import { CreateUnitUseCase } from '@/application/use-cases/create-unit'
import { CreatePriceListUseCase, SetPriceUseCase } from '@/application/use-cases/manage-prices'
import { CatalogDatabase } from '@/infrastructure/database/drizzle/catalog-database'

const clock = { now: () => new Date() }
let database: CatalogDatabase
let application: ReturnType<typeof postgres>
let owner: ReturnType<typeof postgres>

beforeAll(() => {
  database = new CatalogDatabase({ url: process.env.DATABASE_URL ?? '' })
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
  owner = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), application?.end(), owner?.end()])
})

async function seed(tenantId = randomUUID()) {
  await database.provisionTenant(tenantId)
  const unit = await new CreateUnitUseCase(database, clock).execute({
    tenantId,
    code: 'UN',
    name: 'Unit',
    decimalPlaces: 0,
  })
  if (unit.isLeft()) throw unit.value
  const item = await new CreateCatalogItemUseCase(database, clock).execute({
    tenantId,
    kind: 'product',
    sku: 'COFFEE-1',
    name: 'Coffee',
    unitId: unit.value.unitId,
    ncm: '09012100',
  })
  if (item.isLeft()) throw item.value
  const list = await new CreatePriceListUseCase(database, clock).execute({
    tenantId,
    name: 'Base',
    currency: 'BRL',
  })
  if (list.isLeft()) throw list.value
  return {
    tenantId,
    unitId: unit.value.unitId,
    itemId: item.value.itemId,
    listId: list.value.priceListId,
  }
}

it('persists every aggregate and its outbox event atomically', async () => {
  const fixture = await seed()
  const changed = await new SetPriceUseCase(database, clock).execute({
    tenantId: fixture.tenantId,
    priceListId: fixture.listId,
    itemId: fixture.itemId,
    amount: '2590',
    currency: 'BRL',
  })
  expect(changed.isRight()).toBe(true)
  await database.inTenant(fixture.tenantId, async (scope) => {
    expect((await scope.units.findById(fixture.unitId))?.isActive()).toBe(true)
    expect((await scope.items.findById(fixture.itemId))?.isActive()).toBe(true)
    expect((await scope.priceLists.findById(fixture.listId))?.toSnapshot().prices).toEqual([
      { itemId: fixture.itemId, amount: '2590' },
    ])
  })
  const rows =
    await owner`select event_type from outbox where tenant_id = ${fixture.tenantId} order by created_at`
  expect(rows.map((row) => row.event_type)).toEqual([
    'catalog.item.created',
    'catalog.price.changed',
  ])
})

it('enforces cross-tenant isolation for units, items and price lists', async () => {
  const a = await seed()
  const b = await seed()
  await database.inTenant(b.tenantId, async (scope) => {
    expect(await scope.units.findById(a.unitId)).toBeNull()
    expect(await scope.items.findById(a.itemId)).toBeNull()
    expect(await scope.priceLists.findById(a.listId)).toBeNull()
  })
  await expect(
    application.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${b.tenantId}, true)`
      await tx`update catalog_items set name = 'leaked' where id = ${a.itemId}`
      const rows = await tx`select * from catalog_items where id = ${a.itemId}`
      expect(rows).toHaveLength(0)
    }),
  ).resolves.toBeUndefined()
})

it('resets tenant context on pooled connections and rolls back faults', async () => {
  const a = await seed()
  const b = await seed()
  await database.inTenant(a.tenantId, async (scope) => {
    expect(await scope.items.findById(a.itemId)).not.toBeNull()
  })
  await database.inTenant(b.tenantId, async (scope) => {
    expect(await scope.items.findById(a.itemId)).toBeNull()
  })
  await expect(
    database.inTenant(a.tenantId, async (scope) => {
      const item = await scope.items.findById(a.itemId)
      if (!item) throw new Error('fixture missing')
      item.deactivate(new Date())
      await scope.items.save(item)
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  await database.inTenant(a.tenantId, async (scope) => {
    expect((await scope.items.findById(a.itemId))?.isActive()).toBe(true)
  })
})

it('deduplicates consumed events in the same transaction as their effect', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const event = {
    sourceModule: 'identity',
    eventId: randomUUID(),
    eventType: 'identity.tenant.created',
  }
  const first = await database.processEvent(tenantId, event, async () => 'created')
  const duplicate = await database.processEvent(tenantId, event, async () => 'duplicate')
  expect(first).toEqual({ processed: true, value: 'created' })
  expect(duplicate).toEqual({ processed: false })
  await expect(
    database.processEvent(tenantId, { ...event, eventId: randomUUID() }, async () => {
      throw new Error('handler failed')
    }),
  ).rejects.toThrow('handler failed')
  const inbox = await owner`select * from inbox where tenant_id = ${tenantId}`
  expect(inbox).toHaveLength(1)
})

it('uses unprivileged roles and keeps audit records append-only', async () => {
  const [role] =
    await owner`select rolsuper, rolbypassrls from pg_roles where rolname = 'horizon_app'`
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false })
  const privileges = await application`select
    has_table_privilege(current_user, 'catalog_items', 'DELETE') as item_delete,
    has_table_privilege(current_user, 'outbox', 'UPDATE') as outbox_update`
  expect(privileges[0]).toEqual({ item_delete: false, outbox_update: false })
  await expect(owner`truncate audit_log`).rejects.toThrow('append-only')
})
