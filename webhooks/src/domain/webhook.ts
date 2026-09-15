import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export type WebhookEvent = Readonly<{
  eventId: string
  tenantId: string
  eventType: string
  eventVersion: number
  occurredAt: string
  traceId: string
  payload: Readonly<Record<string, unknown>>
}>

export type SubscriptionSnapshot = Readonly<{
  id: string
  tenantId: string
  endpointUrl: string
  eventTypes: readonly string[]
  secret: string
  active: boolean
  createdAt: Date
  updatedAt: Date
}>

export class WebhookSubscription {
  private constructor(private state: SubscriptionSnapshot) {}

  static create(input: {
    tenantId: string
    endpointUrl: string
    eventTypes: readonly string[]
    now: Date
  }): WebhookSubscription {
    const url = new URL(input.endpointUrl)
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Unsupported endpoint protocol')
    if (url.username || url.password) throw new Error('Endpoint credentials are not allowed')
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname))
      throw new Error('Webhook endpoints must use HTTPS')
    const eventTypes = [...new Set(input.eventTypes.map((value) => value.trim()))].sort()
    if (eventTypes.length === 0 || eventTypes.some((value) => !/^[a-z][a-z0-9.-]+$/.test(value)))
      throw new Error('At least one valid event type is required')
    return new WebhookSubscription({
      id: randomUUID(),
      tenantId: input.tenantId,
      endpointUrl: url.toString(),
      eventTypes,
      secret: randomBytes(32).toString('base64url'),
      active: true,
      createdAt: input.now,
      updatedAt: input.now,
    })
  }

  static restore(snapshot: SubscriptionSnapshot): WebhookSubscription {
    return new WebhookSubscription(snapshot)
  }

  matches(eventType: string): boolean {
    return this.state.active && this.state.eventTypes.includes(eventType)
  }

  deactivate(now: Date): void {
    this.state = { ...this.state, active: false, updatedAt: now }
  }

  snapshot(): SubscriptionSnapshot {
    return this.state
  }
}

export type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'dead-letter'

export type DeliverySnapshot = Readonly<{
  id: string
  tenantId: string
  subscriptionId: string
  event: WebhookEvent
  status: DeliveryStatus
  attemptCount: number
  nextAttemptAt: Date
  lockedUntil: Date | null
  lastResponseStatus: number | null
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}>

export class WebhookDelivery {
  private constructor(private state: DeliverySnapshot) {}

  static schedule(subscription: WebhookSubscription, event: WebhookEvent, now: Date) {
    const snapshot = subscription.snapshot()
    if (snapshot.tenantId !== event.tenantId) throw new Error('Delivery tenant mismatch')
    if (!subscription.matches(event.eventType)) throw new Error('Subscription does not match event')
    return new WebhookDelivery({
      id: randomUUID(),
      tenantId: event.tenantId,
      subscriptionId: snapshot.id,
      event,
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: now,
      lockedUntil: null,
      lastResponseStatus: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
  }

  static restore(snapshot: DeliverySnapshot): WebhookDelivery {
    return new WebhookDelivery(snapshot)
  }

  claim(now: Date, leaseMs: number): void {
    if (this.state.status !== 'pending' && this.state.status !== 'delivering')
      throw new Error('Delivery cannot be claimed')
    this.state = {
      ...this.state,
      status: 'delivering',
      lockedUntil: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    }
  }

  succeed(now: Date, responseStatus: number): void {
    this.state = {
      ...this.state,
      status: 'succeeded',
      attemptCount: this.state.attemptCount + 1,
      lockedUntil: null,
      lastResponseStatus: responseStatus,
      lastError: null,
      updatedAt: now,
    }
  }

  fail(input: {
    now: Date
    responseStatus: number | null
    error: string
    policy: RetryPolicy
    random: number
  }): void {
    const attemptCount = this.state.attemptCount + 1
    const exhausted = attemptCount >= input.policy.maxAttempts
    const delay = retryDelayMs(attemptCount, input.policy, input.random)
    this.state = {
      ...this.state,
      status: exhausted ? 'dead-letter' : 'pending',
      attemptCount,
      nextAttemptAt: exhausted ? this.state.nextAttemptAt : new Date(input.now.getTime() + delay),
      lockedUntil: null,
      lastResponseStatus: input.responseStatus,
      lastError: input.error.slice(0, 500),
      updatedAt: input.now,
    }
  }

  replay(now: Date): void {
    if (this.state.status !== 'dead-letter') throw new Error('Only dead letters can be replayed')
    this.state = {
      ...this.state,
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: now,
      lockedUntil: null,
      lastResponseStatus: null,
      lastError: null,
      updatedAt: now,
    }
  }

  snapshot(): DeliverySnapshot {
    return this.state
  }
}

export type RetryPolicy = Readonly<{
  maxAttempts: number
  baseMs: number
  maxMs: number
  jitterRatio: number
}>

export function retryDelayMs(attempt: number, policy: RetryPolicy, random: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Attempt must be positive')
  if (random < 0 || random > 1) throw new Error('Random value must be between zero and one')
  const exponential = Math.min(policy.baseMs * 2 ** (attempt - 1), policy.maxMs)
  const factor = 1 - policy.jitterRatio + random * policy.jitterRatio * 2
  return Math.max(0, Math.round(exponential * factor))
}

export class WebhookSigner {
  sign(secret: string, body: string, timestamp: number): string {
    const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
    return `t=${timestamp},v1=${digest}`
  }

  verify(input: {
    secret: string
    body: string
    signature: string
    nowSeconds: number
    toleranceSeconds: number
  }): boolean {
    const fields = Object.fromEntries(
      input.signature.split(',').map((field) => field.trim().split('=', 2)),
    )
    const timestamp = Number(fields.t)
    if (!Number.isSafeInteger(timestamp)) return false
    if (Math.abs(input.nowSeconds - timestamp) > input.toleranceSeconds) return false
    const expected = Buffer.from(this.sign(input.secret, input.body, timestamp).slice(-64), 'hex')
    const actual = Buffer.from(fields.v1 ?? '', 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
}
