import { randomUUID } from 'node:crypto'
import { InMemoryCatalogUnitOfWork } from 'test/repositories/in-memory-catalog-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { CreateCatalogItemUseCase } from './use-cases/create-catalog-item'
import { CreateUnitUseCase } from './use-cases/create-unit'
import { DeactivateCatalogItemUseCase } from './use-cases/deactivate-catalog-item'
import {
  ListCatalogItemsUseCase,
  ListPriceListsUseCase,
  ListUnitsUseCase,
} from './use-cases/list-catalog'
import { CreatePriceListUseCase, SetPriceUseCase } from './use-cases/manage-prices'

const clock = { now: () => new Date('2026-01-01T00:00:00Z') }
/** Every write names who performed it; the audit chain has no anonymous entries. */
const actor = { type: 'user', id: randomUUID() } as const

async function seed(tenantId: string, unitOfWork = new InMemoryCatalogUnitOfWork()) {
  const unit = await new CreateUnitUseCase(unitOfWork, clock).execute({
    actor,
    tenantId,
    code: 'UN',
    name: 'Unit',
    decimalPlaces: 0,
  })
  if (unit.isLeft()) throw unit.value
  const item = await new CreateCatalogItemUseCase(unitOfWork, clock).execute({
    actor,
    tenantId,
    kind: 'product',
    sku: 'COFFEE-1',
    name: 'Coffee',
    unitId: unit.value.unitId,
    ncm: '09012100',
  })
  if (item.isLeft()) throw item.value
  return { unitOfWork, unitId: unit.value.unitId, itemId: item.value.itemId }
}

describe('catalog use cases', () => {
  it('creates units and rejects invalid or duplicate codes', async () => {
    const tenantId = randomUUID()
    const unitOfWork = new InMemoryCatalogUnitOfWork()
    const useCase = new CreateUnitUseCase(unitOfWork, clock)
    expect(
      (
        await useCase.execute({ actor, tenantId, code: '?', name: 'Unit', decimalPlaces: 0 })
      ).isLeft(),
    ).toBe(true)
    expect(
      (
        await useCase.execute({ actor, tenantId, code: 'UN', name: 'Unit', decimalPlaces: 9 })
      ).isLeft(),
    ).toBe(true)
    expect(
      (
        await useCase.execute({ actor, tenantId, code: 'UN', name: 'Unit', decimalPlaces: 0 })
      ).isRight(),
    ).toBe(true)
    expect(
      (
        await useCase.execute({ actor, tenantId, code: 'un', name: 'Other', decimalPlaces: 0 })
      ).isLeft(),
    ).toBe(true)
  })

  it('requires an active same-tenant unit and unique same-tenant SKU', async () => {
    const tenantA = randomUUID()
    const tenantB = randomUUID()
    const { unitOfWork, unitId } = await seed(tenantA)
    const useCase = new CreateCatalogItemUseCase(unitOfWork, clock)
    expect(
      (
        await useCase.execute({
          actor,
          tenantId: tenantB,
          kind: 'product',
          sku: 'X',
          name: 'X',
          unitId,
        })
      ).isLeft(),
    ).toBe(true)
    expect(
      (
        await useCase.execute({
          actor,
          tenantId: tenantA,
          kind: 'product',
          sku: 'COFFEE-1',
          name: 'Other',
          unitId,
        })
      ).isLeft(),
    ).toBe(true)
    expect(
      (
        await useCase.execute({
          actor,
          tenantId: tenantA,
          kind: 'service',
          sku: 'SERVICE',
          name: 'Service',
          unitId,
        })
      ).isRight(),
    ).toBe(true)
  })

  it('isolates each aggregate between tenants', async () => {
    const tenantA = randomUUID()
    const tenantB = randomUUID()
    const { unitOfWork, itemId } = await seed(tenantA)
    const listing = await new ListCatalogItemsUseCase(unitOfWork).execute({ tenantId: tenantB })
    expect(listing.value.items).toHaveLength(0)
    const deactivated = await new DeactivateCatalogItemUseCase(unitOfWork, clock).execute({
      actor,
      tenantId: tenantB,
      itemId,
    })
    expect(deactivated.isLeft()).toBe(true)
  })

  it('lists every aggregate with bounded cursor pagination', async () => {
    const tenantId = randomUUID()
    const { unitOfWork } = await seed(tenantId)
    const priceList = await new CreatePriceListUseCase(unitOfWork, clock).execute({
      actor,
      tenantId,
      name: 'Base',
      currency: 'BRL',
    })
    expect(priceList.isRight()).toBe(true)
    const units = await new ListUnitsUseCase(unitOfWork).execute({ tenantId, limit: 0 })
    const items = await new ListCatalogItemsUseCase(unitOfWork).execute({
      tenantId,
      limit: 1,
      cursor: '0',
    })
    const prices = await new ListPriceListsUseCase(unitOfWork).execute({ tenantId })
    expect([units.value.items.length, items.value.items.length, prices.value.items.length]).toEqual(
      [1, 1, 1],
    )
  })

  it('creates price lists and changes a price only for an active same-tenant item', async () => {
    const tenantId = randomUUID()
    const { unitOfWork, itemId } = await seed(tenantId)
    const created = await new CreatePriceListUseCase(unitOfWork, clock).execute({
      actor,
      tenantId,
      name: 'Base',
      currency: 'BRL',
    })
    if (created.isLeft()) throw created.value
    expect(
      (
        await new CreatePriceListUseCase(unitOfWork, clock).execute({
          actor,
          tenantId,
          name: 'Base',
          currency: 'BRL',
        })
      ).isLeft(),
    ).toBe(true)
    const setPrice = new SetPriceUseCase(unitOfWork, clock)
    expect(
      (
        await setPrice.execute({
          actor,
          tenantId,
          priceListId: created.value.priceListId,
          itemId,
          amount: '2590',
          currency: 'BRL',
        })
      ).isRight(),
    ).toBe(true)
    expect(
      (
        await setPrice.execute({
          actor,
          tenantId,
          priceListId: created.value.priceListId,
          itemId,
          amount: '1',
          currency: 'USD',
        })
      ).isLeft(),
    ).toBe(true)
    const priceList = unitOfWork.priceLists[0]
    expect(priceList && snapshotOf(priceList).prices[0]).toEqual({ itemId, amount: '2590' })
  })

  it('reports malformed and missing price resources', async () => {
    const tenantId = randomUUID()
    const { unitOfWork, itemId } = await seed(tenantId)
    const create = new CreatePriceListUseCase(unitOfWork, clock)
    expect((await create.execute({ actor, tenantId, name: '', currency: 'BRL' })).isLeft()).toBe(
      true,
    )
    expect(
      (await create.execute({ actor, tenantId, name: 'Base', currency: 'real' })).isLeft(),
    ).toBe(true)
    const setPrice = new SetPriceUseCase(unitOfWork, clock)
    expect(
      (
        await setPrice.execute({
          actor,
          tenantId,
          priceListId: randomUUID(),
          itemId,
          amount: '1',
          currency: 'BRL',
        })
      ).isLeft(),
    ).toBe(true)
    const created = await create.execute({ actor, tenantId, name: 'Base', currency: 'BRL' })
    if (created.isLeft()) throw created.value
    expect(
      (
        await setPrice.execute({
          actor,
          tenantId,
          priceListId: created.value.priceListId,
          itemId: randomUUID(),
          amount: '1',
          currency: 'BRL',
        })
      ).isLeft(),
    ).toBe(true)
    expect(
      (
        await setPrice.execute({
          actor,
          tenantId,
          priceListId: created.value.priceListId,
          itemId,
          amount: '-1',
          currency: 'BRL',
        })
      ).isLeft(),
    ).toBe(true)
  })

  it('deactivates an item once', async () => {
    const tenantId = randomUUID()
    const { unitOfWork, itemId } = await seed(tenantId)
    const useCase = new DeactivateCatalogItemUseCase(unitOfWork, clock)
    expect((await useCase.execute({ actor, tenantId, itemId })).isRight()).toBe(true)
    expect((await useCase.execute({ actor, tenantId, itemId })).isLeft()).toBe(true)
  })
})
