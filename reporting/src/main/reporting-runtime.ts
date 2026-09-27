import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { JournalIntake } from '@/application/journal-intake'
import type { ObjectStore } from '@/application/ports/export-store'
import type { Clock } from '@/application/ports/journal-store'
import {
  ExportWorkUseCase,
  ManageExportSchedulesUseCase,
  ReadExportsUseCase,
  RequestExportUseCase,
} from '@/application/use-cases/exports'
import { ManageSavedFiltersUseCase } from '@/application/use-cases/manage-saved-filters'
import { DashboardUseCase, ReadReportUseCase } from '@/application/use-cases/read-report'
import { RunReconciliationUseCase } from '@/application/use-cases/run-reconciliation'
import { reportFilterOf } from '@/domain/reports'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { ReportingDatabase } from '@/infrastructure/database/drizzle/reporting-database'
import { ExportLinks } from '@/infrastructure/exports/export-links'
import { FileObjectStore, S3ObjectStore } from '@/infrastructure/exports/object-stores'
import { writeFile } from '@/infrastructure/exports/writers'
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
  readonly objectStore: ObjectStore
  readonly exportLinks: ExportLinks
  readonly requestExport: RequestExportUseCase
  readonly readExports: ReadExportsUseCase
  readonly exportSchedules: ManageExportSchedulesUseCase
  readonly exportWork: ExportWorkUseCase

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
    this.objectStore =
      config.EXPORT_STORE === 's3'
        ? new S3ObjectStore(config.EXPORT_BUCKET, {
            endpoint: config.EXPORT_S3_ENDPOINT,
            region: config.EXPORT_S3_REGION,
          })
        : new FileObjectStore(config.EXPORT_FILE_ROOT)
    this.exportLinks = new ExportLinks(config.EXPORT_LINK_SECRET)
    this.requestExport = new RequestExportUseCase(this.database.commands, this.clock)
    this.readExports = new ReadExportsUseCase(this.database.commands, this.objectStore)
    this.exportSchedules = new ManageExportSchedulesUseCase(this.database.commands, this.clock)
    this.exportWork = new ExportWorkUseCase(
      this.database.commands,
      this.database.reports,
      this.objectStore,
      writeFile,
      this.clock,
      {
        retentionMs: config.EXPORT_RETENTION_HOURS * 3_600_000,
        leaseMs: config.EXPORT_LEASE_MS,
        settleGraceMs: config.EXPORT_SETTLE_GRACE_MS,
        batch: 20,
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
