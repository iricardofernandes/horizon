import type { UniqueEntityID } from '../entities/unique-entity-id'

/**
 * Something that happened, recorded on the aggregate that it happened to.
 *
 * The *recording* half of the reference project's domain-event pattern is kept; the
 * *dispatch* half is not. There is no static registry and no in-process bus: a
 * repository pulls these off the aggregate and writes them to the `outbox` table inside
 * the same transaction as the state change, so an event cannot exist without its cause
 * and a cause cannot exist without its event (ADR 0024, `docs/reference-analysis.md` §2.3).
 */
export interface DomainEvent {
  /** `<module>.<aggregate>.<past-tense-verb>` — validated by `@horizon/contracts`. */
  readonly eventType: string

  /** Bumped only on a breaking payload change (ADR 0030). */
  readonly eventVersion: number

  /** When the fact became true, not when it was published. */
  readonly occurredAt: Date

  /** The aggregate this happened to. */
  readonly aggregateId: UniqueEntityID

  /** The tenant the fact belongs to. Stamped on the outbox row and the envelope. */
  readonly tenantId: string

  /** The event body, already in wire shape. Serialised as canonical JSON. */
  payloadOf(): Readonly<Record<string, unknown>>
}
