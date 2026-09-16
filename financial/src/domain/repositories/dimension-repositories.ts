import type { AnalyticDimension, DimensionKind } from '../entities/analytic-dimension'
import type { FinancialCategory } from '../entities/financial-category'
import type { PaymentMethod } from '../entities/payment-method'
import type { PaymentTerm } from '../entities/payment-term'

export abstract class CategoriesRepository {
  abstract findById(id: string): Promise<FinancialCategory | null>
  abstract findByCode(code: string): Promise<FinancialCategory | null>
  abstract create(category: FinancialCategory): Promise<void>
  abstract save(category: FinancialCategory): Promise<void>
}

export abstract class DimensionsRepository {
  abstract findById(id: string): Promise<AnalyticDimension | null>
  abstract findByIds(ids: readonly string[]): Promise<readonly AnalyticDimension[]>
  abstract findByCode(kind: DimensionKind, code: string): Promise<AnalyticDimension | null>
  abstract create(dimension: AnalyticDimension): Promise<void>
  abstract save(dimension: AnalyticDimension): Promise<void>
}

export abstract class PaymentMethodsRepository {
  abstract findById(id: string): Promise<PaymentMethod | null>
  abstract findByCode(code: string): Promise<PaymentMethod | null>
  abstract create(method: PaymentMethod): Promise<void>
  abstract save(method: PaymentMethod): Promise<void>
}

export abstract class PaymentTermsRepository {
  abstract findById(id: string): Promise<PaymentTerm | null>
  abstract findByName(name: string): Promise<PaymentTerm | null>
  abstract create(term: PaymentTerm): Promise<void>
  abstract save(term: PaymentTerm): Promise<void>
}
