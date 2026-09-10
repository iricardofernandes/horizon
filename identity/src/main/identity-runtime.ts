import { readFileSync } from 'node:fs'

import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import Redis from 'ioredis'

import { IdentityPolicy } from '@/application/ports/identity-policy'
import { SessionIssuer } from '@/application/services/session-issuer'
import { AssignRoleUseCase } from '@/application/use-cases/assign-role'
import { AuthenticateApiKeyUseCase } from '@/application/use-cases/authenticate-api-key'
import { AuthenticateUserUseCase } from '@/application/use-cases/authenticate-user'
import { CreateApiKeyUseCase } from '@/application/use-cases/create-api-key'
import { CreateTenantUseCase } from '@/application/use-cases/create-tenant'
import { DisableUserUseCase } from '@/application/use-cases/disable-user'
import { EraseDataSubjectUseCase } from '@/application/use-cases/erase-data-subject'
import { ExportDataSubjectUseCase } from '@/application/use-cases/export-data-subject'
import { ListUsersUseCase } from '@/application/use-cases/list-users'
import { RefreshSessionUseCase } from '@/application/use-cases/refresh-session'
import { RegisterUserUseCase } from '@/application/use-cases/register-user'
import { RevokeApiKeyUseCase } from '@/application/use-cases/revoke-api-key'
import { RevokeSessionUseCase } from '@/application/use-cases/revoke-session'
import { RotateApiKeyUseCase } from '@/application/use-cases/rotate-api-key'
import { VerifyAuditChainUseCase } from '@/application/use-cases/verify-audit-chain'
import { RedisRefreshTokenFamiliesRepository } from '@/infrastructure/cache/redis-refresh-token-families-repository'
import { RedisTokenDenylist } from '@/infrastructure/cache/redis-token-denylist'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { Argon2PasswordHasher } from '@/infrastructure/cryptography/argon2-password-hasher'
import { CryptoSecretGenerator } from '@/infrastructure/cryptography/crypto-secret-generator'
import { EdDsaAccessTokenSigner } from '@/infrastructure/cryptography/ed-dsa-access-token-signer'
import { HmacTokenDigest } from '@/infrastructure/cryptography/hmac-token-digest'
import { SystemClock } from '@/infrastructure/cryptography/system-clock'
import { IdentityDatabase } from '@/infrastructure/database/drizzle/identity-database'
import type { IdentityEnvironment } from './environment'

class ConfiguredIdentityPolicy extends IdentityPolicy {
  constructor(private readonly env: IdentityEnvironment) {
    super()
  }
  override argon2() {
    return {
      memoryKib: this.env.ARGON2_MEMORY_KIB,
      timeCost: this.env.ARGON2_TIME_COST,
      parallelism: this.env.ARGON2_PARALLELISM,
    }
  }
  override session() {
    return {
      absoluteTtlSeconds: this.env.REFRESH_TOKEN_ABSOLUTE_TTL_SECONDS,
      idleTtlSeconds: this.env.REFRESH_TOKEN_IDLE_TTL_SECONDS,
      reuseGraceMs: this.env.REFRESH_TOKEN_REUSE_GRACE_MS,
    }
  }
  override accessTokenTtlSeconds() {
    return this.env.ACCESS_TOKEN_TTL_SECONDS
  }
  override apiKeyEnvironment() {
    return this.env.API_KEY_ENV
  }
}

/** Explicit composition avoids erased interface metadata in the application layer. */
export class IdentityRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: IdentityDatabase
  readonly redis: Redis
  readonly signer: EdDsaAccessTokenSigner
  readonly denylist: RedisTokenDenylist
  readonly createTenant: CreateTenantUseCase
  readonly authenticateUser: AuthenticateUserUseCase
  readonly authenticateApiKey: AuthenticateApiKeyUseCase
  readonly refreshSession: RefreshSessionUseCase
  readonly revokeSession: RevokeSessionUseCase
  readonly registerUser: RegisterUserUseCase
  readonly listUsers: ListUsersUseCase
  readonly disableUser: DisableUserUseCase
  readonly assignRole: AssignRoleUseCase
  readonly createApiKey: CreateApiKeyUseCase
  readonly rotateApiKey: RotateApiKeyUseCase
  readonly revokeApiKey: RevokeApiKeyUseCase
  readonly exportDataSubject: ExportDataSubjectUseCase
  readonly eraseDataSubject: EraseDataSubjectUseCase
  readonly verifyAuditChain: VerifyAuditChainUseCase

  constructor(readonly config: IdentityEnvironment) {
    const hexKey = readFileSync(config.BLIND_INDEX_KEY_PATH, 'utf8').trim()
    if (!/^[a-f\d]{64}$/i.test(hexKey))
      throw new Error('Blind index key file must contain 32 hexadecimal bytes')
    const key = Buffer.from(hexKey, 'hex')
    const policy = new ConfiguredIdentityPolicy(config)
    const clock = new SystemClock()
    const secrets = new CryptoSecretGenerator()
    const box = new AesGcmSecretBox()
    const hasher = new Argon2PasswordHasher(policy.argon2())
    const digest = new HmacTokenDigest(key)
    this.signer = EdDsaAccessTokenSigner.fromFiles({
      privateKeyPath: config.JWT_PRIVATE_KEY_PATH,
      publicKeysDirectory: config.JWT_PUBLIC_KEYS_DIR,
      activeKid: config.JWT_ACTIVE_KID,
      ttlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
      clock,
    })
    this.database = new IdentityDatabase({
      url: config.DATABASE_URL,
      secretBox: box,
      blindIndexKey: key,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    })
    this.redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 5000,
      commandTimeout: 5000,
    })
    this.redis.on('error', () =>
      new Logger(IdentityRuntime.name).warn('Redis connection unavailable'),
    )
    const families = new RedisRefreshTokenFamiliesRepository(this.redis)
    this.denylist = new RedisTokenDenylist(this.redis)
    const sessions = new SessionIssuer(this.signer, families, digest, box, secrets, policy)
    const db = this.database
    this.createTenant = new CreateTenantUseCase(db, db.directory, hasher, secrets, clock)
    this.authenticateUser = new AuthenticateUserUseCase(
      db,
      db.directory,
      hasher,
      sessions,
      policy,
      clock,
    )
    this.authenticateApiKey = new AuthenticateApiKeyUseCase(db, hasher, clock)
    this.refreshSession = new RefreshSessionUseCase(
      db,
      families,
      this.denylist,
      digest,
      box,
      sessions,
      policy,
      clock,
    )
    this.revokeSession = new RevokeSessionUseCase(db, families, this.denylist, clock)
    this.registerUser = new RegisterUserUseCase(db, hasher, secrets, clock)
    this.listUsers = new ListUsersUseCase(db)
    this.disableUser = new DisableUserUseCase(db, families, this.denylist, policy, clock)
    this.assignRole = new AssignRoleUseCase(db, clock)
    this.createApiKey = new CreateApiKeyUseCase(db, hasher, secrets, policy, clock)
    this.rotateApiKey = new RotateApiKeyUseCase(db, hasher, secrets, policy, clock)
    this.revokeApiKey = new RevokeApiKeyUseCase(db, clock)
    this.exportDataSubject = new ExportDataSubjectUseCase(db)
    this.eraseDataSubject = new EraseDataSubjectUseCase(db, families, this.denylist, policy, clock)
    this.verifyAuditChain = new VerifyAuditChainUseCase(db)
  }

  async onModuleInit(): Promise<void> {
    await Promise.all([this.redis.connect(), this.database.ping()])
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect()
    await this.database.close()
  }
}
