import type {
  CategoriesRepository,
  DimensionsRepository,
  PaymentMethodsRepository,
  PaymentTermsRepository,
} from '@/domain/repositories/dimension-repositories'

export interface FinancialScope {
  readonly tenantId: string
  readonly categories: CategoriesRepository
  readonly dimensions: DimensionsRepository
  readonly paymentMethods: PaymentMethodsRepository
  readonly paymentTerms: PaymentTermsRepository
}

export abstract class FinancialUnitOfWork {
  abstract inTenant<T>(tenantId: string, work: (scope: FinancialScope) => Promise<T>): Promise<T>
}
