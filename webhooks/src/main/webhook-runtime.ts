import { type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import {
  CreateSubscriptionUseCase,
  DeactivateSubscriptionUseCase,
  ReplayDeliveryUseCase,
  WebhookDispatcher,
} from '@/application/webhook-service'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { WebhookDatabase } from '@/infrastructure/database/webhook-database'
import { FetchWebhookClient } from '@/infrastructure/http/fetch-webhook-client'
import type { WebhookEnvironment } from './environment'

export class WebhookRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: WebhookDatabase
  readonly createSubscription: CreateSubscriptionUseCase
  readonly deactivateSubscription: DeactivateSubscriptionUseCase
  readonly replayDelivery: ReplayDeliveryUseCase
  readonly dispatcher: WebhookDispatcher
  readonly accessTokens: AccessTokenVerifier

  constructor(config: WebhookEnvironment) {
    const clock = { now: () => new Date() }
    this.database = new WebhookDatabase({
      appUrl: config.DATABASE_URL,
      workerUrl: config.DATABASE_RELAY_URL,
      encryptionKey: Buffer.from(config.WEBHOOK_SECRET_ENCRYPTION_KEY, 'hex'),
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.createSubscription = new CreateSubscriptionUseCase(this.database, clock)
    this.deactivateSubscription = new DeactivateSubscriptionUseCase(this.database, clock)
    this.replayDelivery = new ReplayDeliveryUseCase(this.database, clock)
    this.dispatcher = new WebhookDispatcher(
      this.database,
      new FetchWebhookClient(),
      clock,
      {
        maxAttempts: config.WEBHOOK_MAX_ATTEMPTS,
        baseMs: config.WEBHOOK_BACKOFF_BASE_MS,
        maxMs: config.WEBHOOK_BACKOFF_MAX_MS,
        jitterRatio: config.WEBHOOK_BACKOFF_JITTER_RATIO,
      },
      {
        timeoutMs: config.WEBHOOK_DELIVERY_TIMEOUT_MS,
        batchSize: config.OUTBOX_BATCH_SIZE,
        queueDepthAlert: config.WEBHOOK_QUEUE_DEPTH_ALERT,
      },
    )
  }

  async onModuleInit(): Promise<void> {
    await this.database.queueDepth()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
