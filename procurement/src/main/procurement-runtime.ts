import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ProcurementModuleEventHandlers } from '@/application/consume-module-events'
import { DefineApprovalPolicyUseCase } from '@/application/use-cases/define-policies'
import {
  DecideOrderUseCase,
  DraftOrderFromQuotationUseCase,
  DraftOrderUseCase,
  ReviseOrderUseCase,
} from '@/application/use-cases/manage-orders'
import {
  DeclineQuotationUseCase,
  RecordQuotationUseCase,
  SelectQuotationUseCase,
} from '@/application/use-cases/manage-quotations'
import {
  DecideRequisitionUseCase,
  OpenRequisitionUseCase,
  ReviseRequisitionUseCase,
} from '@/application/use-cases/manage-requisitions'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { ProcurementDatabase } from '@/infrastructure/database/drizzle/procurement-database'
import type { ProcurementEnvironment } from './environment'

/** Explicit composition: every dependency is visible in one place. */
export class ProcurementRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: ProcurementDatabase
  readonly accessTokens: AccessTokenVerifier
  readonly openRequisition: OpenRequisitionUseCase
  readonly reviseRequisition: ReviseRequisitionUseCase
  readonly decideRequisition: DecideRequisitionUseCase
  readonly recordQuotation: RecordQuotationUseCase
  readonly selectQuotation: SelectQuotationUseCase
  readonly declineQuotation: DeclineQuotationUseCase
  readonly draftOrder: DraftOrderUseCase
  readonly draftOrderFromQuotation: DraftOrderFromQuotationUseCase
  readonly reviseOrder: ReviseOrderUseCase
  readonly decideOrder: DecideOrderUseCase
  readonly defineApprovalPolicy: DefineApprovalPolicyUseCase
  readonly eventHandlers: ProcurementModuleEventHandlers

  constructor(config: ProcurementEnvironment) {
    const clock = { now: () => new Date() }
    this.database = new ProcurementDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.openRequisition = new OpenRequisitionUseCase(this.database, clock)
    this.reviseRequisition = new ReviseRequisitionUseCase(this.database, clock)
    this.decideRequisition = new DecideRequisitionUseCase(this.database, clock)
    this.recordQuotation = new RecordQuotationUseCase(this.database, clock)
    this.selectQuotation = new SelectQuotationUseCase(this.database, clock)
    this.declineQuotation = new DeclineQuotationUseCase(this.database, clock)
    this.draftOrder = new DraftOrderUseCase(this.database, clock)
    this.draftOrderFromQuotation = new DraftOrderFromQuotationUseCase(this.database, clock)
    this.reviseOrder = new ReviseOrderUseCase(this.database, clock)
    this.decideOrder = new DecideOrderUseCase(this.database, clock)
    this.defineApprovalPolicy = new DefineApprovalPolicyUseCase(this.database, clock)
    this.eventHandlers = new ProcurementModuleEventHandlers(this.database, clock)
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
