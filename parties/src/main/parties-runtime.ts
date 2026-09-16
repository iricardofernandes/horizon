import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import {
  ChangePartyRoleUseCase,
  ChangePartyStatusUseCase,
  DescribePartyUseCase,
  ErasePartyUseCase,
  RegisterPartyUseCase,
} from '@/application/use-cases/manage-parties'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { PartiesDatabase } from '@/infrastructure/database/drizzle/parties-database'
import type { PartiesEnvironment } from './environment'

/** Explicit composition: every dependency is visible in one place. */
export class PartiesRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: PartiesDatabase
  readonly accessTokens: AccessTokenVerifier
  readonly registerParty: RegisterPartyUseCase
  readonly describeParty: DescribePartyUseCase
  readonly changeRole: ChangePartyRoleUseCase
  readonly changeStatus: ChangePartyStatusUseCase
  readonly eraseParty: ErasePartyUseCase

  constructor(config: PartiesEnvironment) {
    const clock = { now: () => new Date() }
    this.database = new PartiesDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
      privacy: {
        secretBox: new AesGcmSecretBox(),
        blindIndexKey: Buffer.from(config.PARTY_BLIND_INDEX_KEY, 'hex'),
      },
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.registerParty = new RegisterPartyUseCase(this.database, clock)
    this.describeParty = new DescribePartyUseCase(this.database, clock)
    this.changeRole = new ChangePartyRoleUseCase(this.database, clock)
    this.changeStatus = new ChangePartyStatusUseCase(this.database, clock)
    this.eraseParty = new ErasePartyUseCase(this.database, clock)
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
