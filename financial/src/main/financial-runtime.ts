import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import {
  ChangeRegistryStatusUseCase,
  DefineCategoryUseCase,
  DefineDimensionUseCase,
  DefinePaymentMethodUseCase,
  DefinePaymentTermUseCase,
  PreviewAllocationUseCase,
  PreviewScheduleUseCase,
} from '@/application/use-cases/manage-dimensions'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { FinancialDatabase } from '@/infrastructure/database/drizzle/financial-database'
import type { FinancialEnvironment } from './environment'

/** Explicit composition: every dependency is visible in one place. */
export class FinancialRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: FinancialDatabase
  readonly accessTokens: AccessTokenVerifier
  readonly defineCategory: DefineCategoryUseCase
  readonly defineDimension: DefineDimensionUseCase
  readonly definePaymentMethod: DefinePaymentMethodUseCase
  readonly definePaymentTerm: DefinePaymentTermUseCase
  readonly changeStatus: ChangeRegistryStatusUseCase
  readonly previewSchedule: PreviewScheduleUseCase
  readonly previewAllocation: PreviewAllocationUseCase

  constructor(config: FinancialEnvironment) {
    const clock = { now: () => new Date() }
    this.database = new FinancialDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.defineCategory = new DefineCategoryUseCase(this.database, clock)
    this.defineDimension = new DefineDimensionUseCase(this.database, clock)
    this.definePaymentMethod = new DefinePaymentMethodUseCase(this.database, clock)
    this.definePaymentTerm = new DefinePaymentTermUseCase(this.database, clock)
    this.changeStatus = new ChangeRegistryStatusUseCase(this.database, clock)
    this.previewSchedule = new PreviewScheduleUseCase(this.database)
    this.previewAllocation = new PreviewAllocationUseCase(this.database)
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
