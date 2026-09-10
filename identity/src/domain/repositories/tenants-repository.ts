import type { Page, PaginationParams } from '@/core/repositories/pagination-params'
import type { Tenant } from '@/domain/entities/tenant'

/**
 * An abstract class, not an interface — it is simultaneously the compile-time contract
 * and the runtime DI token, which removes the `@Inject('TOKEN')` string-literal pattern
 * entirely (`docs/reference-analysis.md` §1.3).
 *
 * Entity in, entity out. Never a row type: a repository that leaks its persistence shape
 * is an ORM with extra steps.
 */
export abstract class TenantsRepository {
  abstract findById(id: string): Promise<Tenant | null>
  abstract create(tenant: Tenant): Promise<void>
  abstract save(tenant: Tenant): Promise<void>
  abstract list(params: PaginationParams): Promise<Page<Tenant>>
}
