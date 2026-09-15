import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import {
  type ClaimedDelivery,
  type DeliveryAttemptSnapshot,
  WebhookRepository,
} from '@/application/webhook-service'
import {
  type DeliverySnapshot,
  type SubscriptionSnapshot,
  WebhookDelivery,
  type WebhookEvent,
  WebhookSubscription,
} from '@/domain/webhook'

export class WebhookDatabase extends WebhookRepository {
  readonly #app: ReturnType<typeof postgres>
  readonly #worker: ReturnType<typeof postgres>

  constructor(options: { appUrl: string; workerUrl: string; encryptionKey: Uint8Array }) {
    super()
    if (options.encryptionKey.byteLength !== 32)
      throw new Error('Webhook secret encryption key must contain 32 bytes')
    this.key = Buffer.from(options.encryptionKey)
    this.#app = postgres(options.appUrl, { max: 10, connect_timeout: 5 })
    this.#worker = postgres(options.workerUrl, { max: 2, connect_timeout: 5 })
  }

  private readonly key: Buffer

  async provisionTenant(tenantId: string): Promise<void> {
    await this.inTenant(tenantId, async (transaction) => {
      await transaction`insert into tenants (id) values (${tenantId}) on conflict do nothing`
    })
  }

  async createSubscription(subscription: WebhookSubscription): Promise<void> {
    const row = subscription.snapshot()
    await this.inTenant(row.tenantId, async (transaction) => {
      await transaction`insert into webhook_subscriptions
        (id, tenant_id, endpoint_url, event_types, secret_ciphertext, active, created_at, updated_at)
        values (${row.id}, ${row.tenantId}, ${row.endpointUrl}, ${row.eventTypes},
          ${this.seal(row.id, row.secret)}, ${row.active ? 1 : 0}, ${row.createdAt}, ${row.updatedAt})`
    })
  }

  async listSubscriptions(tenantId: string): Promise<readonly SubscriptionSnapshot[]> {
    return this.inTenant(tenantId, async (transaction) => {
      const rows = await transaction`select * from webhook_subscriptions order by created_at desc`
      return rows.map((row) => this.mapSubscription(row).snapshot())
    })
  }

  async findSubscription(tenantId: string, id: string): Promise<WebhookSubscription | null> {
    return this.inTenant(tenantId, async (transaction) => {
      const [row] = await transaction`select * from webhook_subscriptions where id = ${id}`
      return row ? this.mapSubscription(row) : null
    })
  }

  async saveSubscription(subscription: WebhookSubscription): Promise<void> {
    const row = subscription.snapshot()
    await this.inTenant(row.tenantId, async (transaction) => {
      await transaction`update webhook_subscriptions set endpoint_url = ${row.endpointUrl},
        event_types = ${row.eventTypes}, active = ${row.active ? 1 : 0}, updated_at = ${row.updatedAt}
        where id = ${row.id}`
    })
  }

  async recordEvent(event: WebhookEvent, now: Date): Promise<number> {
    return this.inTenant(event.tenantId, async (transaction) => {
      const claimed = await transaction`insert into inbox
        (source_module, event_id, event_type, tenant_id) values
        ('sales', ${event.eventId}, ${event.eventType}, ${event.tenantId})
        on conflict do nothing returning event_id`
      if (claimed.length === 0) return 0
      await transaction`insert into webhook_events
        (event_id, tenant_id, event_type, event_version, occurred_at, trace_id, envelope)
        values (${event.eventId}, ${event.tenantId}, ${event.eventType}, ${event.eventVersion},
          ${event.occurredAt}, ${event.traceId}, ${transaction.json(event as never)})`
      const subscriptions = await transaction`select id from webhook_subscriptions
        where active = 1 and event_types @> array[${event.eventType}]::text[]`
      for (const subscription of subscriptions)
        await transaction`insert into webhook_deliveries
          (id, tenant_id, subscription_id, event_id, status, attempt_count, next_attempt_at,
            created_at, updated_at)
          values (${randomUUID()}, ${event.tenantId}, ${subscription.id}, ${event.eventId},
            'pending', 0, ${now}, ${now}, ${now}) on conflict do nothing`
      return subscriptions.length
    })
  }

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<readonly ClaimedDelivery[]> {
    return this.#worker.begin(async (transaction) => {
      const rows = await transaction`select d.*, e.envelope, s.endpoint_url, s.event_types,
        s.secret_ciphertext, s.active, s.created_at as subscription_created_at,
        s.updated_at as subscription_updated_at
        from webhook_deliveries d
        join webhook_events e on e.tenant_id = d.tenant_id and e.event_id = d.event_id
        join webhook_subscriptions s on s.tenant_id = d.tenant_id and s.id = d.subscription_id
        where ((d.status = 'pending' and d.next_attempt_at <= ${now})
          or (d.status = 'delivering' and d.locked_until <= ${now})) and s.active = 1
        order by d.next_attempt_at, d.id limit ${limit} for update of d skip locked`
      const result: ClaimedDelivery[] = []
      for (const row of rows) {
        const lockedUntil = new Date(now.getTime() + leaseMs)
        await transaction`update webhook_deliveries set status = 'delivering',
          locked_until = ${lockedUntil}, updated_at = ${now} where id = ${row.id}`
        result.push({
          delivery: this.mapDelivery({ ...row, status: 'delivering', locked_until: lockedUntil }),
          subscription: this.mapSubscription({
            id: row.subscription_id,
            tenant_id: row.tenant_id,
            endpoint_url: row.endpoint_url,
            event_types: row.event_types,
            secret_ciphertext: row.secret_ciphertext,
            active: row.active,
            created_at: row.subscription_created_at,
            updated_at: row.subscription_updated_at,
          }),
        })
      }
      return result
    })
  }

  async saveAttempt(input: {
    delivery: WebhookDelivery
    attemptedAt: Date
    durationMs: number
    responseStatus: number | null
    error: string | null
  }): Promise<void> {
    const row = input.delivery.snapshot()
    await this.#worker.begin(async (transaction) => {
      await this.updateDelivery(transaction, row)
      await transaction`insert into webhook_delivery_attempts
        (id, tenant_id, delivery_id, attempt_number, attempted_at, duration_ms,
          response_status, error) values (${randomUUID()}, ${row.tenantId}, ${row.id},
          ${row.attemptCount}, ${input.attemptedAt}, ${input.durationMs},
          ${input.responseStatus}, ${input.error})`
    })
  }

  async findDelivery(tenantId: string, id: string): Promise<WebhookDelivery | null> {
    return this.inTenant(tenantId, async (transaction) => {
      const [row] = await transaction`select d.*, e.envelope from webhook_deliveries d
        join webhook_events e on e.tenant_id = d.tenant_id and e.event_id = d.event_id
        where d.id = ${id}`
      return row ? this.mapDelivery(row) : null
    })
  }

  async listDeliveries(tenantId: string): Promise<readonly DeliverySnapshot[]> {
    return this.inTenant(tenantId, async (transaction) => {
      const rows = await transaction`select d.*, e.envelope from webhook_deliveries d
        join webhook_events e on e.tenant_id = d.tenant_id and e.event_id = d.event_id
        order by d.created_at desc limit 200`
      return rows.map((row) => this.mapDelivery(row).snapshot())
    })
  }

  async listAttempts(
    tenantId: string,
    deliveryId: string,
  ): Promise<readonly DeliveryAttemptSnapshot[]> {
    return this.inTenant(tenantId, async (transaction) => {
      const rows = await transaction`select a.id, a.delivery_id, a.attempt_number,
        a.attempted_at, a.duration_ms, a.response_status, a.error
        from webhook_delivery_attempts a
        join webhook_deliveries d on d.tenant_id = a.tenant_id and d.id = a.delivery_id
        where a.delivery_id = ${deliveryId}
        order by a.attempt_number asc`
      return rows.map((row) => ({
        id: String(row.id),
        deliveryId: String(row.delivery_id),
        attemptNumber: Number(row.attempt_number),
        attemptedAt: new Date(row.attempted_at),
        durationMs: Number(row.duration_ms),
        responseStatus: row.response_status === null ? null : Number(row.response_status),
        error: row.error === null ? null : String(row.error),
      }))
    })
  }

  async saveDelivery(delivery: WebhookDelivery): Promise<void> {
    const row = delivery.snapshot()
    await this.inTenant(row.tenantId, (transaction) => this.updateDelivery(transaction, row))
  }

  async queueDepth(): Promise<number> {
    const [row] = await this.#worker`select count(*)::int as total from webhook_deliveries
      where status in ('pending', 'delivering')`
    return row?.total ?? 0
  }

  async close(): Promise<void> {
    await Promise.all([this.#app.end({ timeout: 5 }), this.#worker.end({ timeout: 5 })])
  }

  private inTenant<T>(
    tenantId: string,
    work: (transaction: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return this.#app.begin(async (transaction) => {
      await transaction`select set_config('app.current_tenant', ${tenantId}, true)`
      return work(transaction)
    }) as Promise<T>
  }

  private updateDelivery(transaction: postgres.TransactionSql, row: DeliverySnapshot) {
    return transaction`update webhook_deliveries set status = ${row.status},
      attempt_count = ${row.attemptCount}, next_attempt_at = ${row.nextAttemptAt},
      locked_until = ${row.lockedUntil}, last_response_status = ${row.lastResponseStatus},
      last_error = ${row.lastError}, updated_at = ${row.updatedAt} where id = ${row.id}`
  }

  private mapSubscription(row: postgres.Row): WebhookSubscription {
    return WebhookSubscription.restore({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      endpointUrl: String(row.endpoint_url),
      eventTypes: row.event_types as string[],
      secret: this.open(String(row.id), String(row.secret_ciphertext)),
      active: row.active === 1,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    })
  }

  private mapDelivery(row: postgres.Row): WebhookDelivery {
    return WebhookDelivery.restore({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      subscriptionId: String(row.subscription_id),
      event: row.envelope as WebhookEvent,
      status: row.status as DeliverySnapshot['status'],
      attemptCount: Number(row.attempt_count),
      nextAttemptAt: new Date(row.next_attempt_at),
      lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
      lastResponseStatus:
        row.last_response_status === null ? null : Number(row.last_response_status),
      lastError: row.last_error === null ? null : String(row.last_error),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    })
  }

  private seal(id: string, value: string): string {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(id))
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return [nonce, cipher.getAuthTag(), encrypted]
      .map((part) => part.toString('base64url'))
      .join('.')
  }

  private open(id: string, value: string): string {
    const [nonce, tag, encrypted] = value
      .split('.')
      .map((part) => Buffer.from(part ?? '', 'base64url'))
    if (!nonce || !tag || !encrypted) throw new Error('Invalid encrypted webhook secret')
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce)
    decipher.setAAD(Buffer.from(id))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  }
}
