import type { Page, PaginationParams } from '@/core/repositories/pagination-params'
import type { CatalogItem } from '../entities/catalog-item'
import type { Composition } from '../entities/composition'
import type { PriceList } from '../entities/price-list'
import type { ProductFamily } from '../entities/product-family'
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

export abstract class ProductFamiliesRepository {
  abstract findById(id: string): Promise<ProductFamily | null>
  abstract findByName(name: string): Promise<ProductFamily | null>
  abstract create(family: ProductFamily): Promise<void>
  abstract save(family: ProductFamily): Promise<void>
  abstract list(params: PaginationParams): Promise<Page<ProductFamily>>
  /**
   * Whether a sibling already answers the family's axes this way.
   *
   * The item cannot see its siblings and the family will not hold them all in memory, so
   * the question is asked here and refused by a unique index if two people ask at once.
   */
  abstract combinationTaken(
    familyId: string,
    combination: string,
    exceptItemId: string,
  ): Promise<boolean>
}

export abstract class CompositionsRepository {
  /** The version in force on a date: the latest one whose effective date has arrived. */
  abstract inForce(parentItemId: string, on: string): Promise<Composition | null>
  /** The newest version by number, in force or not, which is what the next one follows. */
  abstract latest(parentItemId: string): Promise<Composition | null>
  abstract create(composition: Composition): Promise<void>
  /**
   * Whether `target` is somewhere below `from` in the graph of what is made of what.
   *
   * Asked before a composition is written, so the person defining it gets told which
   * component closes the loop rather than a constraint violation. A trigger asks the same
   * question again, because two halves of a cycle can be defined at the same moment and
   * neither walk would have seen the other.
   */
  abstract reaches(from: string, target: string): Promise<boolean>
}
