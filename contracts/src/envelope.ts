import { z } from 'zod'

import { instantSchema, tenantIdSchema, uuidSchema } from './common'

/**
 * The event envelope — identical for every event Horizon publishes (ADR 0030).
 *
 * Events are the durable public interface between modules. Unlike an HTTP call there is
 * no caller to negotiate with: an event is emitted, and any number of consumers,
 * including ones written later, interpret it. Everything a consumer needs to route,
 * deduplicate, scope and trace a message lives here rather than in the payload.
 */
export const eventEnvelopeSchema = z.object({
  /**
   * UUIDv7. This is the deduplication key: a consumer inserts it into its `inbox` table
   * inside the same transaction as the effect, so a redelivery violates the unique
   * constraint and the effect happens exactly once (ADR 0024).
   */
  eventId: uuidSchema,

  /** `<module>.<aggregate>.<past-tense-verb>` — see `eventTypeSchema`. */
  eventType: z.string().min(1),

  /**
   * Incremented only on a breaking change. An additive change bumps the package's minor
   * version and leaves this alone, so existing consumers are unaffected. During a
   * deprecation window the producer emits both versions.
   */
  eventVersion: z.number().int().positive(),

  /**
   * When the fact became true — not when it was published. The outbox relay may publish
   * seconds later, and a consumer reasoning about ordering needs the former.
   */
  occurredAt: instantSchema,

  /** Tenant scope. A consumer never infers tenancy from payload contents (ADR 0017). */
  tenantId: tenantIdSchema,

  /**
   * W3C trace id, propagated through RabbitMQ headers. This is what makes an
   * asynchronous flow one trace end to end rather than several disconnected ones
   * (ADR 0033).
   */
  traceId: z.string().regex(/^[0-9a-f]{32}$/, 'must be a 32-character lowercase hex W3C trace id'),

  /** Event-specific body. Typed per event by `defineEvent`. */
  payload: z.unknown(),
})

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>

/**
 * `<module>.<aggregate>.<past-tense-verb>` — `sales.order.confirmed`.
 *
 * Past tense because an event records something that happened. A command named as an
 * event is the most common way an event-driven system turns back into RPC with extra
 * steps, so the naming rule is enforced by a schema rather than left to review.
 */
export const eventTypeSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/,
    'must be <module>.<aggregate>.<past-tense-verb>, lowercase',
  )

/** An envelope whose payload has been narrowed to a specific event's schema. */
export function envelopeOf<T extends z.ZodType>(payload: T) {
  return eventEnvelopeSchema.extend({ payload })
}
