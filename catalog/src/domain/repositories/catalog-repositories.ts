import type { Page, PaginationParams } from '@/core/repositories/pagination-params'
import type { CatalogItem } from '../entities/catalog-item'
import type { PriceList } from '../entities/price-list'
import type { UnitOfMeasure } from '../entities/unit-of-measure'

export abstract class UnitsRepository {
  abstract findById(id: string): Promise<UnitOfMeasure | null>
  abstract findByCode(code: string): Promise<UnitOfMeasure | null>
  abstract create(unit: UnitOfMeasure): Promise<void>
  abstract save(unit: UnitOfMeasure): Promise<void>
  abstract list(params: PaginationParams): Promise<Page<UnitOfMeasure>>
}
export abstract class CatalogItemsRepository {
  abstract findById(id: string): Promise<CatalogItem | null>
  abstract findBySku(sku: string): Promise<CatalogItem | null>
  abstract create(item: CatalogItem): Promise<void>
  abstract save(item: CatalogItem): Promise<void>
  abstract list(params: PaginationParams): Promise<Page<CatalogItem>>
}
export abstract class PriceListsRepository {
  abstract findById(id: string): Promise<PriceList | null>
  abstract findByName(name: string): Promise<PriceList | null>
  abstract create(priceList: PriceList): Promise<void>
  abstract save(priceList: PriceList): Promise<void>
  abstract list(params: PaginationParams): Promise<Page<PriceList>>
}
