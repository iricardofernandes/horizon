import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { CreateCatalogItemUseCase } from '@/application/use-cases/create-catalog-item'
import { CreateUnitUseCase } from '@/application/use-cases/create-unit'
import { CreatePriceListUseCase, SetPriceUseCase } from '@/application/use-cases/manage-prices'
import { VerifyAuditChainUseCase } from '@/application/use-cases/verify-audit-chain'
import { CatalogDatabase } from '@/infrastructure/database/drizzle/catalog-database'

const clock = { now: () => new Date() }
const actor = { type: 'user', id: randomUUID() } as const
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
    actor,
    tenantId,
    code: 'UN',
    name: 'Unit',
    decimalPlaces: 0,
  })
  if (unit.isLeft()) throw unit.value
  const item = await new CreateCatalogItemUseCase(database, clock).execute({
    actor,
    tenantId,
    kind: 'product',
    sku: 'COFFEE-1',
    name: 'Coffee',
    unitId: unit.value.unitId,
    ncm: '09012100',
  })
  if (item.isLeft()) throw item.value
  const list = await new CreatePriceListUseCase(database, clock).execute({
    actor,
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
    actor,
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

it('chains an audit entry for every catalog change, naming the actor', async () => {
  const fixture = await seed()
  const changed = await new SetPriceUseCase(database, clock).execute({
    actor,
    tenantId: fixture.tenantId,
    priceListId: fixture.listId,
    itemId: fixture.itemId,
    amount: '3990',
    currency: 'BRL',
    requestId: 'audit-e2e',
  })
  expect(changed.isRight()).toBe(true)

  const rows =
    await owner`select * from audit_log where tenant_id = ${fixture.tenantId} order by sequence`
  expect(rows.map((row) => row.action)).toEqual([
    'catalog.unit.created',
    'catalog.item.created',
    'catalog.price-list.created',
    'catalog.price.changed',
  ])
  expect(rows[0]).toMatchObject({ sequence: '1', actor_type: 'user', actor_id: actor.id })
  expect(rows[0]?.previous_hash).toBe('0'.repeat(64))
  expect(rows[3]).toMatchObject({ request_id: 'audit-e2e' })
  expect(rows[3]?.previous_hash).toBe(rows[2]?.hash)

  const verdict = await new VerifyAuditChainUseCase(database).execute({
    tenantId: fixture.tenantId,
  })
  if (verdict.isLeft()) throw verdict.value
  expect(verdict.value).toMatchObject({ intact: true, verifiedThrough: 4, brokenAt: null })
})

it('serializes concurrent appends and names the first link a forgery breaks', async () => {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  await Promise.all(
    Array.from({ length: 8 }, () =>
      database.inTenant(tenantId, (scope) =>
        scope.audit.append({
          actor: { type: 'system', id: null },
          subjectType: 'Catalog',
          subjectId: tenantId,
          action: 'catalog.checked',
          occurredAt: new Date(),
        }),
      ),
    ),
  )
  const sequences = (
    await owner`select sequence from audit_log where tenant_id = ${tenantId} order by sequence`
  ).map((row) => Number(row.sequence))
  // Eight writers, eight consecutive links: the tenant row lock turned a race into a
  // queue rather than into a failed transaction or a forked chain.
  expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

  const verifier = new VerifyAuditChainUseCase(database)
  const before = await verifier.execute({ tenantId })
  if (before.isLeft()) throw before.value
  expect(before.value.intact).toBe(true)

  // Only the table owner can even attempt this, and only by disabling the trigger the
  // migration installed. The point of the chain is that doing so is still detectable.
  await owner.begin(async (tx) => {
    await tx`alter table audit_log disable trigger audit_append_only`
    await tx`update audit_log set action = 'catalog.forged' where tenant_id = ${tenantId} and sequence = 3`
    await tx`alter table audit_log enable trigger audit_append_only`
  })
  const after = await verifier.execute({ tenantId })
  if (after.isLeft()) throw after.value
  expect(after.value).toMatchObject({ intact: false, verifiedThrough: 2, brokenAt: 3 })

  const cli = await runAuditCli(tenantId)
  expect(cli.stderr).toBe('')
  expect(cli.code).toBe(1)
  expect(JSON.parse(cli.stdout)).toMatchObject({ intact: false, verifiedThrough: 2, brokenAt: 3 })
})

async function runAuditCli(
  tenantId: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-r', '@swc-node/register', 'src/infrastructure/cli/verify-audit.ts', tenantId],
      { env: process.env, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}
