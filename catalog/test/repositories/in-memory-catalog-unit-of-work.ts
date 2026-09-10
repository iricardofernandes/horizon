import type { TenantScope } from '@/application/ports/unit-of-work'
import { UnitOfWork } from '@/application/ports/unit-of-work'
import type { Page, PaginationParams } from '@/core/repositories/pagination-params'
import type { CatalogItem } from '@/domain/entities/catalog-item'
import type { PriceList } from '@/domain/entities/price-list'
import type { UnitOfMeasure } from '@/domain/entities/unit-of-measure'
import {
  CatalogItemsRepository,
  PriceListsRepository,
  UnitsRepository,
} from '@/domain/repositories/catalog-repositories'

function page<T extends { id: { toString(): string } }>(
  items: readonly T[],
  params: PaginationParams,
): Page<T> {
  const offset = params.cursor === undefined ? 0 : Number.parseInt(params.cursor, 10)
  const selected = items.slice(offset, offset + params.limit + 1)
  const hasMore = selected.length > params.limit
  const visible = selected.slice(0, params.limit)
  return {
    items: visible,
    hasMore,
    ...(hasMore ? { nextCursor: String(offset + visible.length) } : {}),
  }
}

abstract class TenantRepository<
  T extends { id: { toString(): string }; belongsTo(tenantId: string): boolean },
> {
  constructor(
    protected readonly tenantId: string,
    protected readonly records: T[],
  ) {}
  protected visible(): readonly T[] {
    return this.records.filter((record) => record.belongsTo(this.tenantId))
  }
  protected byId(id: string): T | null {
    return this.visible().find((record) => record.id.toString() === id) ?? null
  }
  protected insert(record: T): void {
    if (!record.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(record)
  }
  protected replace(record: T): void {
    if (!record.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    const index = this.records.findIndex(
      (candidate) =>
        candidate.id.toString() === record.id.toString() && candidate.belongsTo(this.tenantId),
    )
    if (index < 0) throw new Error('record not found')
    this.records[index] = record
  }
}

class InMemoryUnitsRepository extends TenantRepository<UnitOfMeasure> implements UnitsRepository {
  findById(id: string): Promise<UnitOfMeasure | null> {
    return Promise.resolve(this.byId(id))
  }
  findByCode(code: string): Promise<UnitOfMeasure | null> {
    return Promise.resolve(this.visible().find((unit) => unit.toSnapshot().code === code) ?? null)
  }
  create(unit: UnitOfMeasure): Promise<void> {
    this.insert(unit)
    return Promise.resolve()
  }
  save(unit: UnitOfMeasure): Promise<void> {
    this.replace(unit)
    return Promise.resolve()
  }
  list(params: PaginationParams): Promise<Page<UnitOfMeasure>> {
    return Promise.resolve(page(this.visible(), params))
  }
}

class InMemoryItemsRepository
  extends TenantRepository<CatalogItem>
  implements CatalogItemsRepository
{
  findById(id: string): Promise<CatalogItem | null> {
    return Promise.resolve(this.byId(id))
  }
  findBySku(sku: string): Promise<CatalogItem | null> {
    return Promise.resolve(this.visible().find((item) => item.toSnapshot().sku === sku) ?? null)
  }
  create(item: CatalogItem): Promise<void> {
    this.insert(item)
    return Promise.resolve()
  }
  save(item: CatalogItem): Promise<void> {
    this.replace(item)
    return Promise.resolve()
  }
  list(params: PaginationParams): Promise<Page<CatalogItem>> {
    return Promise.resolve(page(this.visible(), params))
  }
}

class InMemoryPriceListsRepository
  extends TenantRepository<PriceList>
  implements PriceListsRepository
{
  findById(id: string): Promise<PriceList | null> {
    return Promise.resolve(this.byId(id))
  }
  findByName(name: string): Promise<PriceList | null> {
    return Promise.resolve(this.visible().find((list) => list.toSnapshot().name === name) ?? null)
  }
  create(priceList: PriceList): Promise<void> {
    this.insert(priceList)
    return Promise.resolve()
  }
  save(priceList: PriceList): Promise<void> {
    this.replace(priceList)
    return Promise.resolve()
  }
  list(params: PaginationParams): Promise<Page<PriceList>> {
    return Promise.resolve(page(this.visible(), params))
  }
}

export class InMemoryCatalogUnitOfWork extends UnitOfWork {
  readonly units: UnitOfMeasure[] = []
  readonly items: CatalogItem[] = []
  readonly priceLists: PriceList[] = []
  inTenant<T>(tenantId: string, work: (scope: TenantScope) => Promise<T>): Promise<T> {
    return work({
      tenantId,
      units: new InMemoryUnitsRepository(tenantId, this.units),
      items: new InMemoryItemsRepository(tenantId, this.items),
      priceLists: new InMemoryPriceListsRepository(tenantId, this.priceLists),
    })
  }
}
