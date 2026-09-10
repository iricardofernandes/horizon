import type {
  CatalogItemsRepository,
  PriceListsRepository,
  UnitsRepository,
} from '@/domain/repositories/catalog-repositories'

export interface TenantScope {
  readonly tenantId: string
  readonly units: UnitsRepository
  readonly items: CatalogItemsRepository
  readonly priceLists: PriceListsRepository
}
export abstract class UnitOfWork {
  abstract inTenant<T>(tenantId: string, work: (scope: TenantScope) => Promise<T>): Promise<T>
}
