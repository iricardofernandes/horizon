import type { CallOutcome } from '@/domain/results'

/** A key exchanged for a token (ADR 0064), as Identity answered through the gateway. */
export interface ExchangedKey {
  readonly apiKeyId: string
  readonly accessToken: string
  readonly scopes: readonly string[]
}

/** Why an exchange did not yield a token; the status is passed on to the caller as it is. */
export interface ExchangeRefusal {
  readonly status: number
  readonly detail: string
  readonly retryAfterSeconds?: number
}

export abstract class KeyExchange {
  abstract exchange(
    tenantId: string,
    presented: string,
  ): Promise<{ ok: true; key: ExchangedKey } | { ok: false; refusal: ExchangeRefusal }>
}

/** A module's answer to a `GET` through the gateway. */
export interface GatewayAnswer {
  readonly status: number
  readonly body: unknown
}

export abstract class Gateway {
  /** `GET path?query` through the gateway with the caller's own token, never another. */
  abstract read(
    path: string,
    query: Readonly<Record<string, string>>,
    accessToken: string,
  ): Promise<GatewayAnswer>

  /**
   * `POST path` through the gateway with the caller's own token and an idempotency key, so
   * a retried call is answered with the first result (ADR 0066). Only draft routes.
   */
  abstract write(
    path: string,
    body: Readonly<Record<string, unknown>>,
    accessToken: string,
    idempotencyKey: string,
  ): Promise<GatewayAnswer>
}

export interface AuditRecord {
  readonly actor: string
  readonly subjectType: string
  readonly subjectId: string
  readonly action: string
  readonly occurredAt: Date
  readonly details: Record<string, unknown>
}

export interface CallRecord {
  readonly tool: string
  readonly outcome: CallOutcome
}

export abstract class AgentStore {
  abstract accessEnabled(tenantId: string): Promise<boolean>
  abstract setAccess(tenantId: string, enabled: boolean, by: string, at: Date): Promise<void>
  abstract audit(tenantId: string, record: AuditRecord): Promise<void>
}

export interface Clock {
  now(): Date
}

export interface CallMetrics {
  called(record: CallRecord): void
  exchanged(seconds: number): void
}
