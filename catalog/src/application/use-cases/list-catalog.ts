import { type Either, right } from '@/core/either'
import { boundedLimit, type Page } from '@/core/repositories/pagination-params'
import type { CatalogItem } from '@/domain/entities/catalog-item'
import type { PriceList } from '@/domain/entities/price-list'
import type { ProductFamily } from '@/domain/entities/product-family'
import type { UnitOfMeasure } from '@/domain/entities/unit-of-measure'
import type { UnitOfWork } from '../ports/unit-of-work'

interface ListRequest {
  readonly tenantId: string
  readonly limit?: number
  readonly cursor?: string
}

function params(request: ListRequest) {
  return {
    limit: boundedLimit(request.limit),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  }
}

export class ListCatalogItemsUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}
  async execute(request: ListRequest): Promise<Either<never, Page<CatalogItem>>> {
    return this.unitOfWork.inTenant(request.tenantId, async (scope) =>
      right(await scope.items.list(params(request))),
    )
  }
}

export class ListUnitsUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}
  async execute(request: ListRequest): Promise<Either<never, Page<UnitOfMeasure>>> {
    return this.unitOfWork.inTenant(request.tenantId, async (scope) =>
      right(await scope.units.list(params(request))),
    )
  }
}

export class ListProductFamiliesUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}
  async execute(request: ListRequest): Promise<Either<never, Page<ProductFamily>>> {
    return this.unitOfWork.inTenant(request.tenantId, async (scope) =>
      right(await scope.families.list(params(request))),
    )
  }
}

export class ListPriceListsUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}
  async execute(request: ListRequest): Promise<Either<never, Page<PriceList>>> {
    return this.unitOfWork.inTenant(request.tenantId, async (scope) =>
      right(await scope.priceLists.list(params(request))),
    )
  }
}
