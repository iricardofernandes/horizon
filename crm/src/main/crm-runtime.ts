import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { CrmModuleEventHandlers } from '@/application/consume-module-events'
import { UpdateAccountProfileUseCase } from '@/application/use-cases/manage-accounts'
import {
  ChangeContactStatusUseCase,
  CreateContactUseCase,
  EraseContactUseCase,
  ReviseContactUseCase,
} from '@/application/use-cases/manage-contacts'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { CrmDatabase } from '@/infrastructure/database/drizzle/crm-database'
import type { CrmEnvironment } from './environment'

/** Explicit composition: every dependency is visible in one place. */
export class CrmRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: CrmDatabase
  readonly accessTokens: AccessTokenVerifier
  readonly updateAccountProfile: UpdateAccountProfileUseCase
  readonly createContact: CreateContactUseCase
  readonly reviseContact: ReviseContactUseCase
  readonly changeContactStatus: ChangeContactStatusUseCase
  readonly eraseContact: EraseContactUseCase
  readonly eventHandlers: CrmModuleEventHandlers

  constructor(config: CrmEnvironment) {
    const clock = { now: () => new Date() }
    this.database = new CrmDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
      secretBox: new AesGcmSecretBox(),
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.updateAccountProfile = new UpdateAccountProfileUseCase(this.database, clock)
    this.createContact = new CreateContactUseCase(this.database, clock)
    this.reviseContact = new ReviseContactUseCase(this.database, clock)
    this.changeContactStatus = new ChangeContactStatusUseCase(this.database, clock)
    this.eraseContact = new EraseContactUseCase(this.database, clock)
    this.eventHandlers = new CrmModuleEventHandlers(this.database, clock)
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
