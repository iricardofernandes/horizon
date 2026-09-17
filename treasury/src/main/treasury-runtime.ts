import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import {
  ChangeAccountStatusUseCase,
  OpenAccountUseCase,
} from '@/application/use-cases/manage-accounts'
import { RecordEntryUseCase, ReverseEntryUseCase } from '@/application/use-cases/manage-journal'
import {
  CancelTransferUseCase,
  PostTransferUseCase,
} from '@/application/use-cases/manage-transfers'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { TreasuryDatabase } from '@/infrastructure/database/drizzle/treasury-database'
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
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
