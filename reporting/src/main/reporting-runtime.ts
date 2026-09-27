import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { JournalIntake } from '@/application/journal-intake'
import type { Clock } from '@/application/ports/journal-store'
import { ManageSavedFiltersUseCase } from '@/application/use-cases/manage-saved-filters'
import { DashboardUseCase, ReadReportUseCase } from '@/application/use-cases/read-report'
import { RunReconciliationUseCase } from '@/application/use-cases/run-reconciliation'
import { reportFilterOf } from '@/domain/reports'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { ReportingDatabase } from '@/infrastructure/database/drizzle/reporting-database'
import { GatewayOwnerReports } from '@/infrastructure/http/gateway-owner-reports'
import type { ReportingEnvironment } from './environment'

/** Explicit composition: every dependency is visible in one place. */
export class ReportingRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: ReportingDatabase
  readonly clock: Clock
  readonly accessTokens: AccessTokenVerifier
  readonly intake: JournalIntake
  readonly readReport: ReadReportUseCase
  readonly dashboard: DashboardUseCase
  readonly runReconciliation: RunReconciliationUseCase
  readonly savedFilters: ManageSavedFiltersUseCase
  readonly filterOf = reportFilterOf

  constructor(config: ReportingEnvironment) {
    this.clock = { now: () => new Date() }
    this.database = new ReportingDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.intake = new JournalIntake(this.database, this.clock)
    this.readReport = new ReadReportUseCase(this.database.reports, this.clock)
    this.dashboard = new DashboardUseCase(this.database.reports, this.clock)
    this.runReconciliation = new RunReconciliationUseCase(
      this.database.reports,
      new GatewayOwnerReports(config.GATEWAY_URL),
      this.database.commands,
      this.clock,
    )
    this.savedFilters = new ManageSavedFiltersUseCase(this.database.commands, this.clock)
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
