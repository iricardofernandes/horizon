import type { Either } from '@/core/either'
import type { UseCaseError } from '@/core/errors/use-case-error'
import type { Page } from '@/core/repositories/pagination-params'
import type { CatalogItem } from '@/domain/entities/catalog-item'
import type { PriceList } from '@/domain/entities/price-list'
import type { UnitOfMeasure } from '@/domain/entities/unit-of-measure'

export function unwrap<L extends UseCaseError, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

/** Explicit allowlists: a snapshot gains a field without it silently reaching the wire. */
export function presentUnit(unit: UnitOfMeasure) {
  const snapshot = unit.toSnapshot()
  return {
    id: snapshot.id,
    code: snapshot.code,
    name: snapshot.name,
    decimalPlaces: snapshot.decimalPlaces,
    active: snapshot.active,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  }
}

export function presentItem(item: CatalogItem) {
  const snapshot = item.toSnapshot()
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    sku: snapshot.sku,
    name: snapshot.name,
    unitId: snapshot.unitId,
    ncm: snapshot.ncm,
    active: snapshot.active,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  }
}

export function presentPriceList(priceList: PriceList) {
  const snapshot = priceList.toSnapshot()
  return {
    id: snapshot.id,
    name: snapshot.name,
    currency: snapshot.currency,
    // Minor units as a string, because JSON cannot carry the bigint (ADR 0010).
    prices: snapshot.prices.map((price) => ({ itemId: price.itemId, amount: price.amount })),
    active: snapshot.active,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  }
}

export function presentPage<T, R>(page: Page<T>, present: (item: T) => R) {
  return {
    data: page.items.map(present),
    page: {
      hasMore: page.hasMore,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    },
  }
}
