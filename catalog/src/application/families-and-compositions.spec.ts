import { randomUUID } from 'node:crypto'
import { InMemoryCatalogUnitOfWork } from 'test/repositories/in-memory-catalog-unit-of-work'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '@/domain/audit/audit-entry'
import { CreateCatalogItemUseCase } from './use-cases/create-catalog-item'
import { CreateUnitUseCase } from './use-cases/create-unit'
import { DefineCompositionUseCase } from './use-cases/define-composition'
import { AssignVariantUseCase, DefineProductFamilyUseCase } from './use-cases/manage-families'

const now = new Date('2026-09-21T09:00:00.000Z')
const clock = { now: () => now }
const actor: Actor = { type: 'user', id: 'user-buyer' }

let unitOfWork: InMemoryCatalogUnitOfWork
let families: DefineProductFamilyUseCase
let variants: AssignVariantUseCase
let compositions: DefineCompositionUseCase
let items: CreateCatalogItemUseCase
let tenantId: string
let unitId: string

const audit = () => ({ actor, requestId: null, traceId: null, sourceIp: null })

function unwrap<E, T>(result: { isLeft(): boolean; isRight(): boolean; value: E | T }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

const item = async (sku: string, kind: 'product' | 'service' = 'product') =>
  unwrap(await items.execute({ tenantId, ...audit(), kind, sku, name: sku, unitId, ncm: null }))
    .itemId

const family = async (name: string, attributes: readonly string[]) =>
  unwrap(await families.execute({ tenantId, ...audit(), name, attributes })).familyId

const compose = (
  parentItemId: string,
  lines: readonly { componentItemId: string; quantity: string }[],
  options: { effectiveFrom?: string; realisation?: 'assembled' | 'exploded' } = {},
) =>
  compositions.execute({
    tenantId,
    ...audit(),
    parentItemId,
    realisation: options.realisation ?? 'assembled',
    effectiveFrom: options.effectiveFrom ?? '2026-09-01',
    lines,
  })

beforeEach(async () => {
  unitOfWork = new InMemoryCatalogUnitOfWork()
  families = new DefineProductFamilyUseCase(unitOfWork, clock)
  variants = new AssignVariantUseCase(unitOfWork, clock)
  compositions = new DefineCompositionUseCase(unitOfWork, clock)
  items = new CreateCatalogItemUseCase(unitOfWork, clock)
  tenantId = randomUUID()
  unitId = unwrap(
    await new CreateUnitUseCase(unitOfWork, clock).execute({
      tenantId,
      ...audit(),
      code: 'UN',
      name: 'Unit',
      decimalPlaces: 0,
    }),
  ).unitId
})

describe('a family of things that differ along named axes', () => {
  it('records the axes it varies along, in the order they were given', async () => {
    const familyId = await family('T-shirt', ['Size', 'Colour'])

    const held = unitOfWork.families.find((one) => one.id.toString() === familyId)
    expect(held?.attributes().map((attribute) => attribute.value)).toEqual(['Size', 'Colour'])
  })

  it('refuses two families with the same name', async () => {
    await family('T-shirt', ['Size'])

    const again = await families.execute({
      tenantId,
      ...audit(),
      name: 'T-shirt',
      attributes: ['Size'],
    })

    expect(again.isLeft()).toBe(true)
  })

  it('refuses the same axis twice, however it was spelled', async () => {
    const twice = await families.execute({
      tenantId,
      ...audit(),
      name: 'T-shirt',
      attributes: ['Size', 'size'],
    })

    expect(twice.isLeft()).toBe(true)
  })

  it('refuses a family that varies along nothing', async () => {
    const empty = await families.execute({ tenantId, ...audit(), name: 'T-shirt', attributes: [] })

    expect(empty.isLeft()).toBe(true)
  })
})

describe('an item taking its place in a family', () => {
  it('keeps the answers under the family’s own spelling, in its own order', async () => {
    const familyId = await family('T-shirt', ['Size', 'Colour'])
    const itemId = await item('TS-L-NAVY')

    unwrap(
      await variants.execute({
        tenantId,
        ...audit(),
        itemId,
        familyId,
        // Answered out of order and in the wrong case; the family settles both.
        values: [
          { attribute: 'colour', value: 'Navy' },
          { attribute: 'SIZE', value: 'L' },
        ],
      }),
    )

    const held = unitOfWork.items.find((one) => one.id.toString() === itemId)
    expect(held?.variantValues()).toEqual([
      { attribute: 'Size', value: 'L' },
      { attribute: 'Colour', value: 'Navy' },
    ])
  })

  it('refuses an axis the family does not vary along', async () => {
    const familyId = await family('T-shirt', ['Size'])
    const itemId = await item('TS-L')

    const assigned = await variants.execute({
      tenantId,
      ...audit(),
      itemId,
      familyId,
      values: [
        { attribute: 'Size', value: 'L' },
        { attribute: 'Sleeve', value: 'short' },
      ],
    })

    expect(assigned.isLeft()).toBe(true)
  })

  it('refuses an axis left unanswered', async () => {
    const familyId = await family('T-shirt', ['Size', 'Colour'])
    const itemId = await item('TS-L')

    const assigned = await variants.execute({
      tenantId,
      ...audit(),
      itemId,
      familyId,
      values: [{ attribute: 'Size', value: 'L' }],
    })

    expect(assigned.isLeft()).toBe(true)
  })

  it('refuses a combination a sibling already answers, whatever case it used', async () => {
    const familyId = await family('T-shirt', ['Size', 'Colour'])
    const first = await item('TS-L-NAVY')
    const second = await item('TS-L-NAVY-2')
    const values = [
      { attribute: 'Size', value: 'L' },
      { attribute: 'Colour', value: 'Navy' },
    ]
    unwrap(await variants.execute({ tenantId, ...audit(), itemId: first, familyId, values }))

    const clash = await variants.execute({
      tenantId,
      ...audit(),
      itemId: second,
      familyId,
      values: [
        { attribute: 'Size', value: 'l' },
        { attribute: 'Colour', value: 'NAVY' },
      ],
    })

    expect(clash.isLeft()).toBe(true)
  })

  it('lets the same item restate the same answers', async () => {
    const familyId = await family('T-shirt', ['Size'])
    const itemId = await item('TS-L')
    const values = [{ attribute: 'Size', value: 'L' }]
    unwrap(await variants.execute({ tenantId, ...audit(), itemId, familyId, values }))

    const again = await variants.execute({ tenantId, ...audit(), itemId, familyId, values })

    expect(again.isRight()).toBe(true)
  })

  it('refuses to move an item from one family to another', async () => {
    const shirts = await family('T-shirt', ['Size'])
    const mugs = await family('Mug', ['Size'])
    const itemId = await item('TS-L')
    const values = [{ attribute: 'Size', value: 'L' }]
    unwrap(await variants.execute({ tenantId, ...audit(), itemId, familyId: shirts, values }))

    // The answers were given against the shirt's axes; carrying them to another family
    // would leave the item describing itself in a vocabulary nobody uses any more.
    const moved = await variants.execute({ tenantId, ...audit(), itemId, familyId: mugs, values })

    expect(moved.isLeft()).toBe(true)
  })
})

describe('what an item is made of', () => {
  it('records a version that takes effect from a date', async () => {
    const chair = await item('CHAIR')
    const leg = await item('LEG')

    const defined = unwrap(await compose(chair, [{ componentItemId: leg, quantity: '4' }]))

    expect(defined.version).toBe(1)
    expect(unitOfWork.compositions).toHaveLength(1)
  })

  it('supersedes rather than edits, numbering each version after the last', async () => {
    const chair = await item('CHAIR')
    const leg = await item('LEG')
    unwrap(await compose(chair, [{ componentItemId: leg, quantity: '4' }]))

    const second = unwrap(
      await compose(chair, [{ componentItemId: leg, quantity: '3' }], {
        effectiveFrom: '2026-10-01',
      }),
    )

    // The order that consumed four is not wrong because the recipe now says three.
    expect(second.version).toBe(2)
    expect(unitOfWork.compositions).toHaveLength(2)
  })

  it('refuses a version that would take effect before the one it supersedes', async () => {
    const chair = await item('CHAIR')
    const leg = await item('LEG')
    unwrap(
      await compose(chair, [{ componentItemId: leg, quantity: '4' }], {
        effectiveFrom: '2026-10-01',
      }),
    )

    const backwards = await compose(chair, [{ componentItemId: leg, quantity: '3' }], {
      effectiveFrom: '2026-09-01',
    })

    expect(backwards.isLeft()).toBe(true)
  })

  it('refuses an item made of itself', async () => {
    const chair = await item('CHAIR')

    const itself = await compose(chair, [{ componentItemId: chair, quantity: '1' }])

    expect(itself.isLeft()).toBe(true)
  })

  it('refuses a cycle however far down it closes', async () => {
    const chair = await item('CHAIR')
    const frame = await item('FRAME')
    const bracket = await item('BRACKET')
    unwrap(await compose(chair, [{ componentItemId: frame, quantity: '1' }]))
    unwrap(await compose(frame, [{ componentItemId: bracket, quantity: '2' }]))

    // A bracket made of chairs would leave the catalogue unable to say what anything
    // costs or how long anything takes.
    const loop = await compose(bracket, [{ componentItemId: chair, quantity: '1' }])

    expect(loop.isLeft()).toBe(true)
  })

  it('refuses the same component twice on one recipe', async () => {
    const chair = await item('CHAIR')
    const leg = await item('LEG')

    const twice = await compose(chair, [
      { componentItemId: leg, quantity: '2' },
      { componentItemId: leg, quantity: '2' },
    ])

    expect(twice.isLeft()).toBe(true)
  })

  it('refuses none of a component', async () => {
    const chair = await item('CHAIR')
    const leg = await item('LEG')

    const nothing = await compose(chair, [{ componentItemId: leg, quantity: '0' }])

    expect(nothing.isLeft()).toBe(true)
  })

  it('refuses a service as the thing being made', async () => {
    const fitting = await item('FITTING', 'service')
    const leg = await item('LEG')

    // A service is delivered rather than assembled; a bundle of them is a contract.
    const made = await compose(fitting, [{ componentItemId: leg, quantity: '1' }])

    expect(made.isLeft()).toBe(true)
  })

  it('takes a service as a component of a product', async () => {
    const chair = await item('CHAIR')
    const fitting = await item('FITTING', 'service')

    const bundled = await compose(chair, [{ componentItemId: fitting, quantity: '1' }], {
      realisation: 'exploded',
    })

    expect(bundled.isRight()).toBe(true)
  })

  it('names whoever defined it in the audit chain', async () => {
    const chair = await item('CHAIR')
    const leg = await item('LEG')

    unwrap(await compose(chair, [{ componentItemId: leg, quantity: '4' }]))

    const entry = unitOfWork.auditRecordsWritten.at(-1)
    expect(entry?.action).toBe('catalog.composition.defined')
    expect(entry?.subjectType).toBe('Composition')
    expect(entry?.actor).toEqual(actor)
  })
})
