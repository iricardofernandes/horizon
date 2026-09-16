import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  ChangeRegistryStatusUseCase,
  DefineCategoryUseCase,
  DefineDimensionUseCase,
  DefinePaymentTermUseCase,
  PreviewAllocationUseCase,
  PreviewScheduleUseCase,
} from '@/application/use-cases/manage-dimensions'
import { FinancialDatabase } from '@/infrastructure/database/drizzle/financial-database'

const clock = { now: () => new Date() }
let database: FinancialDatabase
let application: ReturnType<typeof postgres>
let administrator: ReturnType<typeof postgres>

beforeAll(() => {
  database = new FinancialDatabase({ url: process.env.DATABASE_URL ?? '' })
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), application?.end(), administrator?.end()])
})

function created(result: { isLeft(): boolean; value: unknown }): string {
  if (result.isLeft()) throw result.value
  return (result.value as { id: string }).id
}

it('builds a category tree whose codes are unique per workspace, not globally', async () => {
  const tenant = randomUUID()
  const define = new DefineCategoryUseCase(database, clock)
  const root = created(
    await define.execute({ tenantId: tenant, code: '1', name: 'Revenue', nature: 'revenue' }),
  )
  created(
    await define.execute({
      tenantId: tenant,
      code: '1.01',
      name: 'Product sales',
      nature: 'revenue',
      parentId: root,
    }),
  )

  expect(
    (
      await define.execute({ tenantId: tenant, code: '1', name: 'Again', nature: 'revenue' })
    ).isLeft(),
  ).toBe(true)
  expect(
    (
      await define.execute({
        tenantId: randomUUID(),
        code: '1',
        name: 'Revenue',
        nature: 'revenue',
      })
    ).isRight(),
  ).toBe(true)

  const tree = await database.listCategories(tenant)
  expect(tree.map((category) => [category.code, category.depth, category.parentId])).toEqual([
    ['1', 1, null],
    ['1.01', 2, root],
  ])
})

it('refuses a parent from another workspace, even when its id is known', async () => {
  const owner = randomUUID()
  const foreignRoot = created(
    await new DefineCategoryUseCase(database, clock).execute({
      tenantId: owner,
      code: '9',
      name: 'Expenses',
      nature: 'expense',
    }),
  )
  const result = await new DefineCategoryUseCase(database, clock).execute({
    tenantId: randomUUID(),
    code: '9.01',
    name: 'Rent',
    nature: 'expense',
    parentId: foreignRoot,
  })
  expect(result.isLeft()).toBe(true)
})

it('stores a payment term and previews the schedule it produces', async () => {
  const tenant = randomUUID()
  const termId = created(
    await new DefinePaymentTermUseCase(database, clock).execute({
      tenantId: tenant,
      name: '30/60/90',
      installments: [
        { dueInDays: 30, percentage: '33.34' },
        { dueInDays: 60, percentage: '33.33' },
        { dueInDays: 90, percentage: '33.33' },
      ],
    }),
  )
  const preview = await new PreviewScheduleUseCase(database).execute({
    tenantId: tenant,
    paymentTermId: termId,
    total: { amount: '100000', currency: 'brl' },
    issuedOn: '2026-09-16',
  })
  expect(preview.isRight() && preview.value).toEqual([
    { number: 1, dueOn: '2026-10-16', amount: '33340', currency: 'BRL' },
    { number: 2, dueOn: '2026-11-15', amount: '33330', currency: 'BRL' },
    { number: 3, dueOn: '2026-12-15', amount: '33330', currency: 'BRL' },
  ])
  const [row] = await administrator`select installments from payment_terms where id = ${termId}`
  expect(row?.installments).toEqual([
    { dueInDays: 30, basisPoints: 3334 },
    { dueInDays: 60, basisPoints: 3333 },
    { dueInDays: 90, basisPoints: 3333 },
  ])
})

it('allocates only to active dimensions of the same workspace, and exactly 100%', async () => {
  const tenant = randomUUID()
  const define = new DefineDimensionUseCase(database, clock)
  const sales = created(
    await define.execute({ tenantId: tenant, kind: 'department', code: 'SAL', name: 'Sales' }),
  )
  const launch = created(
    await define.execute({ tenantId: tenant, kind: 'project', code: 'LAUNCH', name: 'Launch' }),
  )
  const preview = new PreviewAllocationUseCase(database)
  const total = { amount: '1000', currency: 'BRL' }

  const split = await preview.execute({
    tenantId: tenant,
    total,
    entries: [
      { dimensionId: sales, percentage: '66.67' },
      { dimensionId: launch, percentage: '33.33' },
    ],
  })
  expect(split.isRight() && split.value.map((part) => part.amount)).toEqual(['667', '333'])

  expect(
    (
      await preview.execute({
        tenantId: tenant,
        total,
        entries: [{ dimensionId: sales, percentage: '99' }],
      })
    ).isLeft(),
  ).toBe(true)
  expect(
    (
      await preview.execute({
        tenantId: randomUUID(),
        total,
        entries: [{ dimensionId: sales, percentage: '100' }],
      })
    ).isLeft(),
  ).toBe(true)

  await new ChangeRegistryStatusUseCase(database, clock).execute({
    tenantId: tenant,
    registry: 'dimensions',
    id: launch,
    active: false,
  })
  expect(
    (
      await preview.execute({
        tenantId: tenant,
        total,
        entries: [{ dimensionId: launch, percentage: '100' }],
      })
    ).isLeft(),
  ).toBe(true)
})

it('never shows one workspace another workspace’s registries, and never lets it delete them', async () => {
  const owner = randomUUID()
  created(
    await new DefineDimensionUseCase(database, clock).execute({
      tenantId: owner,
      kind: 'department',
      code: 'OPS',
      name: 'Operations',
    }),
  )
  const rows = await application.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${randomUUID()}, true)`
    return tx`select id from analytic_dimensions`
  })
  expect(rows).toHaveLength(0)
  const [privileges] = await application`select
    has_table_privilege(current_user, 'analytic_dimensions', 'DELETE') as dimension_delete,
    has_table_privilege(current_user, 'payment_terms', 'DELETE') as term_delete`
  expect(privileges).toEqual({ dimension_delete: false, term_delete: false })
})
