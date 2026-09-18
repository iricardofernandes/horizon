import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { FinancialModuleEventHandlers } from '@/application/consume-module-events'
import {
  DecidePayableApprovalUseCase,
  DefineApprovalPolicyUseCase,
} from '@/application/use-cases/approve-payables'
import {
  ChangeRegistryStatusUseCase,
  DefineCategoryUseCase,
  DefineDimensionUseCase,
  DefinePaymentMethodUseCase,
  DefinePaymentTermUseCase,
  PreviewAllocationUseCase,
  PreviewScheduleUseCase,
} from '@/application/use-cases/manage-dimensions'
import {
  CancelTitleUseCase,
  DraftTitleUseCase,
  PostTitleUseCase,
  RealiseForecastUseCase,
  RecordSettlementUseCase,
  ReverseSettlementUseCase,
  ReverseTitleUseCase,
  ReviseTitleUseCase,
} from '@/application/use-cases/manage-titles'
import type { TitleDirection } from '@/domain/entities/title'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { FinancialDatabase } from '@/infrastructure/database/drizzle/financial-database'
import type { FinancialEnvironment } from './environment'

export type TitleCommands = ReturnType<typeof titleCommands>

/** One set of title commands per direction, over the same kernel. */
function titleCommands(
  database: FinancialDatabase,
  clock: { now(): Date },
  direction: TitleDirection,
) {
  return {
    draft: new DraftTitleUseCase(database, clock, direction),
    revise: new ReviseTitleUseCase(database, clock, direction),
    realise: new RealiseForecastUseCase(database, clock, direction),
    post: new PostTitleUseCase(database, clock, direction),
    cancel: new CancelTitleUseCase(database, clock, direction),
    reverse: new ReverseTitleUseCase(database, clock, direction),
    settle: new RecordSettlementUseCase(database, clock, direction),
    reverseSettlement: new ReverseSettlementUseCase(database, clock, direction),
  }
}

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
  readonly titles: Readonly<Record<TitleDirection, TitleCommands>>
  readonly payableApprovals: DecidePayableApprovalUseCase
  readonly defineApprovalPolicy: DefineApprovalPolicyUseCase
  readonly eventHandlers: FinancialModuleEventHandlers

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
    this.titles = {
      receivable: titleCommands(this.database, clock, 'receivable'),
      payable: titleCommands(this.database, clock, 'payable'),
    }
    this.payableApprovals = new DecidePayableApprovalUseCase(this.database, clock)
    this.defineApprovalPolicy = new DefineApprovalPolicyUseCase(this.database, clock)
    this.eventHandlers = new FinancialModuleEventHandlers(this.database, clock)
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
