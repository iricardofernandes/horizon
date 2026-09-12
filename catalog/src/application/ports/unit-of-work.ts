import type { AuditLogRepository } from '@/domain/repositories/audit-log-repository'
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
  readonly audit: AuditLogRepository
}
export abstract class UnitOfWork {
  abstract inTenant<T>(tenantId: string, work: (scope: TenantScope) => Promise<T>): Promise<T>
}
