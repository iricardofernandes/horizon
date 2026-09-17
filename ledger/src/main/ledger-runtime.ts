import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { LedgerModuleEventHandlers } from '@/application/consume-module-events'
import {
  ChangeAccountStatusUseCase,
  OpenAccountUseCase,
} from '@/application/use-cases/manage-chart'
import { ClosePeriodUseCase, ReopenPeriodUseCase } from '@/application/use-cases/manage-periods'
import { DefineAccountMappingUseCase } from '@/application/use-cases/map-accounts'
import {
  PostTransactionUseCase,
  ReverseTransactionUseCase,
} from '@/application/use-cases/post-journal'
import { ReplayPendingFactsUseCase } from '@/application/use-cases/replay-pending'
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
  readonly defineMapping: DefineAccountMappingUseCase
  readonly replayPending: ReplayPendingFactsUseCase
  readonly eventHandlers: LedgerModuleEventHandlers

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
    this.defineMapping = new DefineAccountMappingUseCase(this.database, clock)
    this.replayPending = new ReplayPendingFactsUseCase(this.database, clock)
    this.eventHandlers = new LedgerModuleEventHandlers(this.database, clock)
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
