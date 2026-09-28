import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from '@horizon/contracts'
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { FinancialModuleEventHandlers } from '@/application/consume-module-events'
import { ImportJobs } from '@/application/imports/imports'
import type { RowKey } from '@/application/imports/ports'
import { TitleImporter } from '@/application/imports/title-importer'
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
import { PLAIN_ROWS, SqlImportStore } from '@/infrastructure/database/drizzle/import-store'
import { RowWritingUnitOfWork } from '@/infrastructure/imports/financial-rows'
import { TabularImportFiles } from '@/infrastructure/imports/tabular-files'
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
  readonly imports: ImportJobs

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
    const database = this.database
    const rows = (key: RowKey) => new RowWritingUnitOfWork(database, key)
    this.imports = new ImportJobs(
      new SqlImportStore(database, PLAIN_ROWS, 'financial'),
      new TabularImportFiles(),
      [
        new TitleImporter('receivable', database, clock, rows),
        new TitleImporter('payable', database, clock, rows),
      ],
      clock,
      {
        maxRows: IMPORT_MAX_ROWS,
        maxBytes: IMPORT_MAX_BYTES,
        batchSize: config.IMPORT_BATCH_SIZE,
        leaseMs: config.IMPORT_LEASE_MS,
        retentionMs: config.IMPORT_RETENTION_HOURS * 3_600_000,
      },
    )
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
