import { type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { SalesModuleEventHandlers } from '@/application/consume-module-events'
import { AcceptQuoteUseCase, CreateQuoteUseCase } from '@/application/use-cases/manage-quotes'
import { PlaceOrderUseCase } from '@/application/use-cases/place-order'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { SalesDatabase } from '@/infrastructure/database/drizzle/sales-database'
import type { SalesEnvironment } from './environment'

export class SalesRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: SalesDatabase
  readonly eventHandlers: SalesModuleEventHandlers
  readonly createQuote: CreateQuoteUseCase
  readonly acceptQuote: AcceptQuoteUseCase
  readonly placeOrder: PlaceOrderUseCase
  readonly accessTokens: AccessTokenVerifier

  constructor(config: SalesEnvironment) {
    const clock = { now: () => new Date() }
    this.database = new SalesDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
      customerPrivacy: {
        secretBox: new AesGcmSecretBox(),
        blindIndexKey: Buffer.from(config.CUSTOMER_BLIND_INDEX_KEY, 'hex'),
      },
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.eventHandlers = new SalesModuleEventHandlers(this.database, clock)
    this.createQuote = new CreateQuoteUseCase(
      this.database,
      clock,
      config.QUOTE_DEFAULT_VALIDITY_DAYS,
    )
    this.acceptQuote = new AcceptQuoteUseCase(this.database, clock)
    this.placeOrder = new PlaceOrderUseCase(this.database, clock)
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
