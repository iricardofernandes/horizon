import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { CreateCatalogItemUseCase } from '@/application/use-cases/create-catalog-item'
import { CreateUnitUseCase } from '@/application/use-cases/create-unit'
import { DefineCompositionUseCase } from '@/application/use-cases/define-composition'
import {
  AssignVariantUseCase,
  DefineProductFamilyUseCase,
} from '@/application/use-cases/manage-families'
import type { Either } from '@/core/either'
import { CatalogDatabase } from '@/infrastructure/database/drizzle/catalog-database'

const clock = { now: () => new Date() }
const actor = { type: 'user', id: randomUUID() } as const
const audit = { actor, requestId: null, traceId: null, sourceIp: null }

/** Dated against the clock the suite runs on, never written into the source. */
const today = () => clock.now().toISOString().slice(0, 10)
const daysFromToday = (days: number) => {
  const day = clock.now()
  day.setUTCDate(day.getUTCDate() + days)
  return day.toISOString().slice(0, 10)
}

let database: CatalogDatabase
let owner: ReturnType<typeof postgres>

beforeAll(() => {
  database = new CatalogDatabase({ url: process.env.DATABASE_URL ?? '' })
  owner = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), owner?.end()])
})

function unwrap<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

interface World {
  readonly tenantId: string
  readonly unitId: string
}

async function workspace(): Promise<World> {
  const tenantId = randomUUID()
  await database.provisionTenant(tenantId)
  const unit = unwrap(
    await new CreateUnitUseCase(database, clock).execute({
      tenantId,
      ...audit,
      code: 'UN',
      name: 'Unit',
      decimalPlaces: 0,
    }),
  )
  return { tenantId, unitId: unit.unitId }
}

const item = async (world: World, sku: string, kind: 'product' | 'service' = 'product') =>
  unwrap(
    await new CreateCatalogItemUseCase(database, clock).execute({
      tenantId: world.tenantId,
      ...audit,
      kind,
      sku,
      name: sku,
      unitId: world.unitId,
      ncm: null,
    }),
  ).itemId

const compose = (
  world: World,
  parentItemId: string,
  lines: readonly { componentItemId: string; quantity: string }[],
  options: { effectiveFrom?: string; realisation?: 'assembled' | 'exploded' } = {},
) =>
  new DefineCompositionUseCase(database, clock).execute({
    tenantId: world.tenantId,
    ...audit,
    parentItemId,
    realisation: options.realisation ?? 'assembled',
    effectiveFrom: options.effectiveFrom ?? daysFromToday(-30),
    lines,
  })

it('multiplies the levels through, and sums a part that turns up twice', async () => {
  const world = await workspace()
  const chair = await item(world, 'CHAIR')
  const frame = await item(world, 'FRAME')
  const leg = await item(world, 'LEG')
  const screw = await item(world, 'SCREW')
  // A chair is a frame and four legs; a frame is two screws; a leg is one screw.
  unwrap(
    await compose(world, chair, [
      { componentItemId: frame, quantity: '1' },
      { componentItemId: leg, quantity: '4' },
    ]),
  )
  unwrap(await compose(world, frame, [{ componentItemId: screw, quantity: '2' }]))
  unwrap(await compose(world, leg, [{ componentItemId: screw, quantity: '1' }]))

  const exploded = await database.explodeComposition(world.tenantId, {
    parentItemId: chair,
    on: today(),
    leavesOnly: true,
  })

  // Two screws through the frame plus one each through four legs: six, listed once.
  expect(exploded.map((row) => [row.sku, row.quantity])).toEqual([['SCREW', '6']])
})

it('keeps the sub-assemblies when asked for the whole tree', async () => {
  const world = await workspace()
  const chair = await item(world, 'CHAIR')
  const frame = await item(world, 'FRAME')
  const screw = await item(world, 'SCREW')
  unwrap(await compose(world, chair, [{ componentItemId: frame, quantity: '1' }]))
  unwrap(await compose(world, frame, [{ componentItemId: screw, quantity: '2' }]))

  const whole = await database.explodeComposition(world.tenantId, {
    parentItemId: chair,
    on: today(),
    leavesOnly: false,
  })

  expect(whole.map((row) => [row.sku, row.quantity, row.compound])).toEqual([
    ['FRAME', '1', true],
    ['SCREW', '2', false],
  ])
})

it('answers with the version in force on the day asked about', async () => {
  const world = await workspace()
  const chair = await item(world, 'CHAIR')
  const leg = await item(world, 'LEG')
  unwrap(
    await compose(world, chair, [{ componentItemId: leg, quantity: '4' }], {
      effectiveFrom: daysFromToday(-30),
    }),
  )
  unwrap(
    await compose(world, chair, [{ componentItemId: leg, quantity: '3' }], {
      effectiveFrom: daysFromToday(30),
    }),
  )

  const nowInForce = await database.compositionInForce(world.tenantId, {
    parentItemId: chair,
    on: today(),
  })
  const later = await database.compositionInForce(world.tenantId, {
    parentItemId: chair,
    on: daysFromToday(40),
  })

  // The order that consumed four is not wrong because the recipe will say three.
  expect(nowInForce?.version).toBe(1)
  expect(nowInForce?.components[0]?.quantity).toBe('4')
  expect(later?.version).toBe(2)
  expect(later?.components[0]?.quantity).toBe('3')
})

it('refuses a cycle in the database as well as in the use case', async () => {
  const world = await workspace()
  const chair = await item(world, 'CHAIR')
  const frame = await item(world, 'FRAME')
  unwrap(await compose(world, chair, [{ componentItemId: frame, quantity: '1' }]))

  const loop = await compose(world, frame, [{ componentItemId: chair, quantity: '1' }])
  expect(loop.isLeft()).toBe(true)

  // And again by the trigger, for the two people who define halves of one at once.
  const [composition] =
    await owner`select id from compositions where tenant_id = ${world.tenantId} limit 1`
  await expect(
    owner`insert into composition_lines (tenant_id, composition_id, component_item_id, quantity)
      values (${world.tenantId}, ${composition?.id}, ${chair}, 1000000)`,
  ).rejects.toThrow(/part of itself/)
})

it('never rewrites a published recipe, whatever gets past the aggregate', async () => {
  const world = await workspace()
  const chair = await item(world, 'CHAIR')
  const leg = await item(world, 'LEG')
  unwrap(await compose(world, chair, [{ componentItemId: leg, quantity: '4' }]))

  await expect(
    owner`update compositions set realisation = 'exploded' where tenant_id = ${world.tenantId}`,
  ).rejects.toThrow(/superseded, never rewritten/)
})

it('refuses two variants of a family that answer the axes the same way', async () => {
  const world = await workspace()
  const familyId = unwrap(
    await new DefineProductFamilyUseCase(database, clock).execute({
      tenantId: world.tenantId,
      ...audit,
      name: 'T-shirt',
      attributes: ['Size', 'Colour'],
    }),
  ).familyId
  const variants = new AssignVariantUseCase(database, clock)
  const first = await item(world, 'TS-1')
  const second = await item(world, 'TS-2')
  const values = [
    { attribute: 'Size', value: 'L' },
    { attribute: 'Colour', value: 'Navy' },
  ]
  unwrap(
    await variants.execute({ tenantId: world.tenantId, ...audit, itemId: first, familyId, values }),
  )

  const clash = await variants.execute({
    tenantId: world.tenantId,
    ...audit,
    itemId: second,
    familyId,
    values,
  })
  expect(clash.isLeft()).toBe(true)

  // And the index refuses it too, for the two people who ask at the same moment.
  await expect(
    owner`insert into item_variants (tenant_id, item_id, family_id, combination, values, updated_at)
      values (${world.tenantId}, ${second}, ${familyId}, 'size\u001el\u001fcolour\u001enavy', '[]'::jsonb, now())`,
  ).rejects.toThrow()
})

it('lists a family’s variants with the answers that tell them apart', async () => {
  const world = await workspace()
  const familyId = unwrap(
    await new DefineProductFamilyUseCase(database, clock).execute({
      tenantId: world.tenantId,
      ...audit,
      name: 'T-shirt',
      attributes: ['Size'],
    }),
  ).familyId
  const variants = new AssignVariantUseCase(database, clock)
  for (const size of ['L', 'M']) {
    const itemId = await item(world, `TS-${size}`)
    unwrap(
      await variants.execute({
        tenantId: world.tenantId,
        ...audit,
        itemId,
        familyId,
        values: [{ attribute: 'Size', value: size }],
      }),
    )
  }

  const listed = await database.listVariants(world.tenantId, { familyId, limit: 50, offset: 0 })

  expect(listed.map((row) => [row.sku, row.values])).toEqual([
    ['TS-L', [{ attribute: 'Size', value: 'L' }]],
    ['TS-M', [{ attribute: 'Size', value: 'M' }]],
  ])
})

it('keeps one workspace’s recipes out of another’s', async () => {
  const ours = await workspace()
  const theirs = await workspace()
  const ourChair = await item(ours, 'CHAIR')
  const ourLeg = await item(ours, 'LEG')
  const theirChair = await item(theirs, 'CHAIR')
  const theirLeg = await item(theirs, 'LEG')
  unwrap(await compose(ours, ourChair, [{ componentItemId: ourLeg, quantity: '4' }]))
  unwrap(await compose(theirs, theirChair, [{ componentItemId: theirLeg, quantity: '8' }]))

  const found = await database.compositionInForce(ours.tenantId, {
    parentItemId: ourChair,
    on: today(),
  })

  expect(found?.components[0]?.quantity).toBe('4')
  expect(
    await database.compositionInForce(ours.tenantId, { parentItemId: theirChair, on: today() }),
  ).toBeNull()
})
