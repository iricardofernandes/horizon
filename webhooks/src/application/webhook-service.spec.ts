import {
  type DeliverySnapshot,
  type SubscriptionSnapshot,
  WebhookDelivery,
  type WebhookEvent,
  WebhookSigner,
  WebhookSubscription,
} from '@/domain/webhook'
import {
  type ClaimedDelivery,
  CreateSubscriptionUseCase,
  type DeliveryAttemptSnapshot,
  ReplayDeliveryUseCase,
  WebhookDispatcher,
  type WebhookHttpClient,
  WebhookRepository,
} from './webhook-service'

class MemoryRepository extends WebhookRepository {
  subscriptions = new Map<string, WebhookSubscription>()
  deliveries = new Map<string, WebhookDelivery>()
  attempts: Array<{ deliveryId: string; error: string | null }> = []

  async createSubscription(value: WebhookSubscription) {
    this.subscriptions.set(value.snapshot().id, value)
  }
  async listSubscriptions(tenantId: string): Promise<readonly SubscriptionSnapshot[]> {
    return [...this.subscriptions.values()]
      .map((item) => item.snapshot())
      .filter((item) => item.tenantId === tenantId)
  }
  async findSubscription(tenantId: string, id: string) {
    const value = this.subscriptions.get(id) ?? null
    return value?.snapshot().tenantId === tenantId ? value : null
  }
  async saveSubscription(value: WebhookSubscription) {
    this.subscriptions.set(value.snapshot().id, value)
  }
  async recordEvent(event: WebhookEvent, now: Date) {
    let scheduled = 0
    for (const subscription of this.subscriptions.values()) {
      if (
        !subscription.matches(event.eventType) ||
        subscription.snapshot().tenantId !== event.tenantId
      )
        continue
      const delivery = WebhookDelivery.schedule(subscription, event, now)
      this.deliveries.set(delivery.snapshot().id, delivery)
      scheduled += 1
    }
    return scheduled
  }
  async claimDue(now: Date, limit: number, leaseMs: number): Promise<readonly ClaimedDelivery[]> {
    return [...this.deliveries.values()]
      .filter((item) => {
        const row = item.snapshot()
        return (
          (row.status === 'pending' && row.nextAttemptAt <= now) ||
          (row.status === 'delivering' && row.lockedUntil !== null && row.lockedUntil <= now)
        )
      })
      .slice(0, limit)
      .map((delivery) => {
        delivery.claim(now, leaseMs)
        const subscription = this.subscriptions.get(delivery.snapshot().subscriptionId)
        if (!subscription) throw new Error('Missing subscription')
        return { delivery, subscription }
      })
  }
  async saveAttempt(input: { delivery: WebhookDelivery; error: string | null }) {
    this.deliveries.set(input.delivery.snapshot().id, input.delivery)
    this.attempts.push({ deliveryId: input.delivery.snapshot().id, error: input.error })
  }
  async findDelivery(tenantId: string, id: string) {
    const value = this.deliveries.get(id) ?? null
    return value?.snapshot().tenantId === tenantId ? value : null
  }
  async listDeliveries(tenantId: string): Promise<readonly DeliverySnapshot[]> {
    return [...this.deliveries.values()]
      .map((item) => item.snapshot())
      .filter((item) => item.tenantId === tenantId)
  }
  async listAttempts(
    tenantId: string,
    deliveryId: string,
  ): Promise<readonly DeliveryAttemptSnapshot[]> {
    const delivery = this.deliveries.get(deliveryId)
    if (delivery?.snapshot().tenantId !== tenantId) return []
    return this.attempts
      .filter((attempt) => attempt.deliveryId === deliveryId)
      .map((attempt, index) => ({
        id: `attempt-${index + 1}`,
        deliveryId,
        attemptNumber: index + 1,
        attemptedAt: new Date(0),
        durationMs: 0,
        responseStatus: null,
        error: attempt.error,
      }))
  }
  async saveDelivery(value: WebhookDelivery) {
    this.deliveries.set(value.snapshot().id, value)
  }
  async queueDepth() {
    return [...this.deliveries.values()].filter((item) =>
      ['pending', 'delivering'].includes(item.snapshot().status),
    ).length
  }
}

const event: WebhookEvent = {
  eventId: '01999999-9999-7999-8999-999999999999',
  tenantId: '01888888-8888-7888-8888-888888888888',
  eventType: 'sales.order.confirmed',
  eventVersion: 1,
  occurredAt: '2026-09-14T12:00:00.000Z',
  traceId: '0123456789abcdef0123456789abcdef',
  payload: { orderId: '01777777-7777-7777-8777-777777777777' },
}

describe('webhook reliability', () => {
  it('rejects a tampered payload and a stale signature', () => {
    const signer = new WebhookSigner()
    const signature = signer.sign('secret', '{"amount":10}', 1000)
    expect(
      signer.verify({
        secret: 'secret',
        body: '{"amount":11}',
        signature,
        nowSeconds: 1000,
        toleranceSeconds: 300,
      }),
    ).toBe(false)
    expect(
      signer.verify({
        secret: 'secret',
        body: '{"amount":10}',
        signature,
        nowSeconds: 1301,
        toleranceSeconds: 300,
      }),
    ).toBe(false)
  })

  it('dead-letters a permanent failure and makes it replayable', async () => {
    let now = new Date('2026-09-14T12:00:00.000Z')
    const repository = new MemoryRepository()
    const created = await new CreateSubscriptionUseCase(repository, { now: () => now }).execute({
      tenantId: event.tenantId,
      endpointUrl: 'https://example.test/hooks',
      eventTypes: [event.eventType],
    })
    await repository.recordEvent(event, now)
    const failing: WebhookHttpClient = {
      post: async () => ({ status: 503 }),
    }
    const dispatcher = new WebhookDispatcher(
      repository,
      failing,
      { now: () => now },
      { maxAttempts: 3, baseMs: 1000, maxMs: 10_000, jitterRatio: 0.2 },
      { timeoutMs: 500, batchSize: 10, queueDepthAlert: 100 },
      () => 0.5,
    )
    await dispatcher.flush()
    now = new Date(now.getTime() + 1000)
    await dispatcher.flush()
    now = new Date(now.getTime() + 2000)
    await dispatcher.flush()
    const [deadLetter] = await repository.listDeliveries(event.tenantId)
    expect(deadLetter?.status).toBe('dead-letter')
    expect(deadLetter?.attemptCount).toBe(3)
    expect(repository.attempts).toHaveLength(3)

    await new ReplayDeliveryUseCase(repository, { now: () => now }).execute({
      tenantId: event.tenantId,
      deliveryId: deadLetter?.id ?? '',
    })
    const replayed = await repository.findDelivery(event.tenantId, deadLetter?.id ?? '')
    expect(replayed?.snapshot()).toMatchObject({ status: 'pending', attemptCount: 0 })
    expect(
      (await repository.findSubscription(event.tenantId, created.subscriptionId))?.matches(
        event.eventType,
      ),
    ).toBe(true)
  })
})
