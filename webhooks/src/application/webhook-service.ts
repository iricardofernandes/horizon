import {
  EndpointRefusedError,
  isLoopbackHost,
  isPublicAddress,
  literalAddress,
} from '@/domain/endpoint'
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

/** Resolves a host name to its addresses; empty when it does not resolve. */
export interface EndpointResolver {
  addressesOf(hostname: string): Promise<readonly string[]>
}

/** Where webhooks may go (Phase 90). Without a resolver, only the URL itself is checked. */
export interface EgressPolicy {
  readonly allowLoopback: boolean
  readonly resolver?: EndpointResolver
}

export class CreateSubscriptionUseCase {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly clock: { now(): Date },
    private readonly egress: EgressPolicy = { allowLoopback: false },
  ) {}

  async execute(input: { tenantId: string; endpointUrl: string; eventTypes: readonly string[] }) {
    const subscription = WebhookSubscription.create({
      ...input,
      now: this.clock.now(),
      allowLoopback: this.egress.allowLoopback,
    })
    await this.refusePrivateResolution(subscription.snapshot().endpointUrl)
    await this.repository.createSubscription(subscription)
    const snapshot = subscription.snapshot()
    return { subscriptionId: snapshot.id, secret: snapshot.secret }
  }

  /**
   * A host that resolves to an address outside the public internet is refused now, so the
   * tenant hears of it at once. One that does not resolve yet is kept: delivery resolves it
   * again, and refuses it then, connection by connection.
   */
  private async refusePrivateResolution(endpointUrl: string): Promise<void> {
    const url = new URL(endpointUrl)
    if (!this.egress.resolver || literalAddress(url.hostname) !== null) return
    if (this.egress.allowLoopback && isLoopbackHost(url.hostname)) return
    const addresses = await this.egress.resolver.addressesOf(url.hostname)
    if (addresses.some((address) => !isPublicAddress(address)))
      throw new EndpointRefusedError('The endpoint must be a public address')
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
      error = failureOf(cause, responseStatus)
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

/**
 * What the attempt log keeps of a failure: a category, never the error's own text (Phase
 * 90). The tenant reads the log, and a network error's text describes the network.
 */
export function failureOf(cause: unknown, responseStatus: number | null): string {
  if (responseStatus !== null) return `HTTP ${responseStatus}`
  if (cause instanceof EndpointRefusedError) return 'refused: not a public address'
  const name = cause instanceof Error ? cause.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  const code = String((cause as { code?: unknown } | null)?.code ?? '')
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(code)) return 'tls'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  return 'connection failed'
}
