import { type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { SalesModuleEventHandlers } from '@/application/consume-module-events'
import { ConvertQuoteUseCase } from '@/application/use-cases/convert-quote'
import {
  DecideQuoteUseCase,
  ReviseQuoteUseCase,
  WriteQuoteUseCase,
} from '@/application/use-cases/manage-quotes'
import { PlaceOrderUseCase } from '@/application/use-cases/place-order'
import {
  AbandonShipmentUseCase,
  DispatchShipmentUseCase,
  PackShipmentUseCase,
  PickShipmentUseCase,
  ReturnShipmentUseCase,
} from '@/application/use-cases/ship-orders'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { SalesDatabase } from '@/infrastructure/database/drizzle/sales-database'
import type { SalesEnvironment } from './environment'

export class SalesRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: SalesDatabase
  readonly eventHandlers: SalesModuleEventHandlers
  readonly writeQuote: WriteQuoteUseCase
  readonly reviseQuote: ReviseQuoteUseCase
  readonly decideQuote: DecideQuoteUseCase
  readonly convertQuote: ConvertQuoteUseCase
  readonly placeOrder: PlaceOrderUseCase
  readonly pickShipment: PickShipmentUseCase
  readonly packShipment: PackShipmentUseCase
  readonly dispatchShipment: DispatchShipmentUseCase
  readonly returnShipment: ReturnShipmentUseCase
  readonly abandonShipment: AbandonShipmentUseCase
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
    this.writeQuote = new WriteQuoteUseCase(
      this.database,
      clock,
      config.QUOTE_DEFAULT_VALIDITY_DAYS,
    )
    this.reviseQuote = new ReviseQuoteUseCase(
      this.database,
      clock,
      config.QUOTE_DEFAULT_VALIDITY_DAYS,
    )
    this.decideQuote = new DecideQuoteUseCase(this.database, clock)
    this.convertQuote = new ConvertQuoteUseCase(this.database, clock)
    this.placeOrder = new PlaceOrderUseCase(this.database, clock)
    this.pickShipment = new PickShipmentUseCase(this.database, clock)
    this.packShipment = new PackShipmentUseCase(this.database, clock)
    this.dispatchShipment = new DispatchShipmentUseCase(this.database, clock)
    this.returnShipment = new ReturnShipmentUseCase(this.database, clock)
    this.abandonShipment = new AbandonShipmentUseCase(this.database, clock)
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
