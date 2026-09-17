import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import {
  ChangeAccountStatusUseCase,
  OpenAccountUseCase,
} from '@/application/use-cases/manage-chart'
import { ClosePeriodUseCase, ReopenPeriodUseCase } from '@/application/use-cases/manage-periods'
import {
  PostTransactionUseCase,
  ReverseTransactionUseCase,
} from '@/application/use-cases/post-journal'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { LedgerDatabase } from '@/infrastructure/database/drizzle/ledger-database'
import type { LedgerEnvironment } from './environment'

/** Explicit composition: every dependency is visible in one place. */
export class LedgerRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: LedgerDatabase
  readonly accessTokens: AccessTokenVerifier
  readonly openAccount: OpenAccountUseCase
  readonly changeAccountStatus: ChangeAccountStatusUseCase
  readonly postTransaction: PostTransactionUseCase
  readonly reverseTransaction: ReverseTransactionUseCase
  readonly closePeriod: ClosePeriodUseCase
  readonly reopenPeriod: ReopenPeriodUseCase

  constructor(config: LedgerEnvironment) {
    const clock = { now: () => new Date() }
    this.database = new LedgerDatabase({
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
    this.postTransaction = new PostTransactionUseCase(this.database, clock)
    this.reverseTransaction = new ReverseTransactionUseCase(this.database, clock)
    this.closePeriod = new ClosePeriodUseCase(this.database, clock)
    this.reopenPeriod = new ReopenPeriodUseCase(this.database, clock)
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
