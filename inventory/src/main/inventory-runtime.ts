import { type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { InventorySalesEventHandlers } from '@/application/consume-sales-events'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { InventoryDatabase } from '@/infrastructure/database/drizzle/inventory-database'
import type { InventoryEnvironment } from './environment'

export class InventoryRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: InventoryDatabase
  readonly eventHandlers: InventorySalesEventHandlers
  readonly accessTokens: AccessTokenVerifier

  constructor(config: InventoryEnvironment) {
    this.database = new InventoryDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.eventHandlers = new InventorySalesEventHandlers(
      this.database,
      { now: () => new Date() },
      config.RESERVATION_TTL_SECONDS,
    )
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
