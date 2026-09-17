import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { TreasuryModuleEventHandlers } from '@/application/consume-module-events'
import { ImportStatementUseCase } from '@/application/use-cases/import-statements'
import {
  ChangeAccountStatusUseCase,
  OpenAccountUseCase,
} from '@/application/use-cases/manage-accounts'
import { RecordEntryUseCase, ReverseEntryUseCase } from '@/application/use-cases/manage-journal'
import {
  CancelTransferUseCase,
  PostTransferUseCase,
} from '@/application/use-cases/manage-transfers'
import {
  ClosePeriodUseCase,
  ConfirmMatchUseCase,
  DismissSuggestionUseCase,
  IgnoreStatementLinesUseCase,
  ReopenPeriodUseCase,
  UndoReconciliationUseCase,
} from '@/application/use-cases/reconcile'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { TreasuryDatabase } from '@/infrastructure/database/drizzle/treasury-database'
import { CsvStatementAdapter } from '@/infrastructure/statements/csv-adapter'
import { OfxStatementAdapter } from '@/infrastructure/statements/ofx-adapter'
import type { TreasuryEnvironment } from './environment'

/** Explicit composition: every dependency is visible in one place. */
export class TreasuryRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: TreasuryDatabase
  readonly accessTokens: AccessTokenVerifier
  readonly openAccount: OpenAccountUseCase
  readonly changeAccountStatus: ChangeAccountStatusUseCase
  readonly recordEntry: RecordEntryUseCase
  readonly reverseEntry: ReverseEntryUseCase
  readonly postTransfer: PostTransferUseCase
  readonly cancelTransfer: CancelTransferUseCase
  readonly importStatement: ImportStatementUseCase
  readonly confirmMatch: ConfirmMatchUseCase
  readonly ignoreLines: IgnoreStatementLinesUseCase
  readonly undoReconciliation: UndoReconciliationUseCase
  readonly dismissSuggestion: DismissSuggestionUseCase
  readonly closePeriod: ClosePeriodUseCase
  readonly reopenPeriod: ReopenPeriodUseCase
  readonly eventHandlers: TreasuryModuleEventHandlers

  constructor(config: TreasuryEnvironment) {
    const clock = { now: () => new Date() }
    this.database = new TreasuryDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.openAccount = new OpenAccountUseCase(this.database, clock)
    this.changeAccountStatus = new ChangeAccountStatusUseCase(this.database, clock)
    this.recordEntry = new RecordEntryUseCase(this.database, clock)
    this.reverseEntry = new ReverseEntryUseCase(this.database, clock)
    this.postTransfer = new PostTransferUseCase(this.database, clock)
    this.cancelTransfer = new CancelTransferUseCase(this.database, clock)
    this.importStatement = new ImportStatementUseCase(this.database, clock, {
      ofx: new OfxStatementAdapter(),
      csv: new CsvStatementAdapter(),
    })
    this.confirmMatch = new ConfirmMatchUseCase(this.database, clock)
    this.ignoreLines = new IgnoreStatementLinesUseCase(this.database, clock)
    this.undoReconciliation = new UndoReconciliationUseCase(this.database, clock)
    this.dismissSuggestion = new DismissSuggestionUseCase(this.database, clock)
    this.closePeriod = new ClosePeriodUseCase(this.database, clock)
    this.reopenPeriod = new ReopenPeriodUseCase(this.database, clock)
    this.eventHandlers = new TreasuryModuleEventHandlers(this.database, clock)
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
