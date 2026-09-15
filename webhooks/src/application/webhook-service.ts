import {
  type DeliverySnapshot,
  type RetryPolicy,
  type SubscriptionSnapshot,
  WebhookDelivery,
  type WebhookEvent,
  WebhookSigner,
  WebhookSubscription,
} from '@/domain/webhook'

export interface ClaimedDelivery {
  readonly delivery: WebhookDelivery
  readonly subscription: WebhookSubscription
}

export type DeliveryAttemptSnapshot = Readonly<{
  id: string
  deliveryId: string
  attemptNumber: number
  attemptedAt: Date
  durationMs: number
  responseStatus: number | null
  error: string | null
}>

export abstract class WebhookRepository {
  abstract createSubscription(subscription: WebhookSubscription): Promise<void>
  abstract listSubscriptions(tenantId: string): Promise<readonly SubscriptionSnapshot[]>
  abstract findSubscription(tenantId: string, id: string): Promise<WebhookSubscription | null>
  abstract saveSubscription(subscription: WebhookSubscription): Promise<void>
  abstract recordEvent(event: WebhookEvent, now: Date): Promise<number>
  abstract claimDue(now: Date, limit: number, leaseMs: number): Promise<readonly ClaimedDelivery[]>
  abstract saveAttempt(input: {
    delivery: WebhookDelivery
    attemptedAt: Date
    durationMs: number
    responseStatus: number | null
    error: string | null
  }): Promise<void>
  abstract findDelivery(tenantId: string, id: string): Promise<WebhookDelivery | null>
  abstract listDeliveries(tenantId: string): Promise<readonly DeliverySnapshot[]>
  abstract listAttempts(
    tenantId: string,
    deliveryId: string,
  ): Promise<readonly DeliveryAttemptSnapshot[]>
  abstract saveDelivery(delivery: WebhookDelivery): Promise<void>
  abstract queueDepth(): Promise<number>
}

export interface WebhookHttpClient {
  post(input: {
    url: string
    body: string
    headers: Readonly<Record<string, string>>
    timeoutMs: number
  }): Promise<{ status: number }>
}

export class CreateSubscriptionUseCase {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly clock: { now(): Date },
  ) {}

  async execute(input: { tenantId: string; endpointUrl: string; eventTypes: readonly string[] }) {
    const subscription = WebhookSubscription.create({ ...input, now: this.clock.now() })
    await this.repository.createSubscription(subscription)
    const snapshot = subscription.snapshot()
    return { subscriptionId: snapshot.id, secret: snapshot.secret }
  }
}

export class DeactivateSubscriptionUseCase {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly clock: { now(): Date },
  ) {}

  async execute(input: { tenantId: string; subscriptionId: string }): Promise<void> {
    const subscription = await this.repository.findSubscription(
      input.tenantId,
      input.subscriptionId,
    )
    if (!subscription) throw new Error('Webhook subscription was not found')
    subscription.deactivate(this.clock.now())
    await this.repository.saveSubscription(subscription)
  }
}

export class ReplayDeliveryUseCase {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly clock: { now(): Date },
  ) {}

  async execute(input: { tenantId: string; deliveryId: string }): Promise<void> {
    const delivery = await this.repository.findDelivery(input.tenantId, input.deliveryId)
    if (!delivery) throw new Error('Webhook delivery was not found')
    delivery.replay(this.clock.now())
    await this.repository.saveDelivery(delivery)
  }
}

export class WebhookDispatcher {
  private readonly signer = new WebhookSigner()

  constructor(
    private readonly repository: WebhookRepository,
    private readonly http: WebhookHttpClient,
    private readonly clock: { now(): Date },
    private readonly policy: RetryPolicy,
    private readonly options: { timeoutMs: number; batchSize: number; queueDepthAlert: number },
    private readonly random: () => number = Math.random,
  ) {}

  async flush(): Promise<{ attempted: number; queueDepth: number; overDepthLimit: boolean }> {
    const claimed = await this.repository.claimDue(
      this.clock.now(),
      this.options.batchSize,
      this.options.timeoutMs * 2,
    )
    for (const item of claimed) await this.deliver(item)
    const queueDepth = await this.repository.queueDepth()
    return {
      attempted: claimed.length,
      queueDepth,
      overDepthLimit: queueDepth > this.options.queueDepthAlert,
    }
  }

  private async deliver(item: ClaimedDelivery): Promise<void> {
    const startedAt = this.clock.now()
    const delivery = item.delivery
    const snapshot = delivery.snapshot()
    const body = JSON.stringify(snapshot.event)
    const timestamp = Math.floor(startedAt.getTime() / 1000)
    let responseStatus: number | null = null
    let error: string | null = null
    try {
      const response = await this.http.post({
        url: item.subscription.snapshot().endpointUrl,
        body,
        timeoutMs: this.options.timeoutMs,
        headers: {
          'content-type': 'application/json',
          'x-horizon-event-id': snapshot.event.eventId,
          'x-horizon-signature': this.signer.sign(
            item.subscription.snapshot().secret,
            body,
            timestamp,
          ),
        },
      })
      responseStatus = response.status
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Endpoint returned HTTP ${response.status}`)
      delivery.succeed(this.clock.now(), response.status)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Webhook delivery failed'
      delivery.fail({
        now: this.clock.now(),
        responseStatus,
        error,
        policy: this.policy,
        random: this.random(),
      })
    }
    const finishedAt = this.clock.now()
    await this.repository.saveAttempt({
      delivery,
      attemptedAt: startedAt,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      responseStatus,
      error,
    })
  }
}
