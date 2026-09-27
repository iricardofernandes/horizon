import {
  EVENTS,
  type EventEnvelope,
  eventEnvelopeSchema,
  findEvent,
  journalSealSchema,
} from '@horizon/contracts'
import { sourceOf } from '@/domain/journal'
import type { Clock, JournalStore } from './ports/journal-store'
import { ApplySealUseCase, type SealResult } from './use-cases/apply-seal'
import { JournalEventUseCase, type JournalOutcome } from './use-cases/journal-event'

/** A message no retry can fix: it is dead-lettered at once. */
export class Undeliverable extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'Undeliverable'
  }
}

/** Every published event type of the journaled modules: what the live queue is bound to. */
export const JOURNALED_EVENT_TYPES: readonly string[] = [
  ...new Set(EVENTS.map((event) => event.type).filter((type) => sourceOf(type) !== null)),
].sort()

/** The contract's own check, so a payload the producer could not have sent is refused. */
function envelopeOf(body: unknown): EventEnvelope {
  const parsed = eventEnvelopeSchema.safeParse(body)
  if (!parsed.success) throw new Undeliverable('not an event envelope')
  const definition = findEvent(parsed.data.eventType, parsed.data.eventVersion)
  if (!definition) throw new Undeliverable('unknown event type or version')
  if (!definition.payload.safeParse(parsed.data.payload).success)
    throw new Undeliverable('payload does not match its contract')
  if (!sourceOf(parsed.data.eventType)) throw new Undeliverable('event of a module not journaled')
  return parsed.data
}

/** The two ways into the journal: the live flow and a producer's replay (ADR 0058). */
export class JournalIntake {
  private readonly journal: JournalEventUseCase
  private readonly seals: ApplySealUseCase

  constructor(store: JournalStore, clock: Clock) {
    this.journal = new JournalEventUseCase(store)
    this.seals = new ApplySealUseCase(store, clock)
  }

  async live(body: unknown): Promise<JournalOutcome> {
    return this.journal.execute(envelopeOf(body), 'live')
  }

  /** A replayed event, or the seal that follows a producer's resend. */
  async replay(body: unknown): Promise<JournalOutcome | SealResult> {
    if (typeof body === 'object' && body !== null && 'kind' in body) {
      const parsed = journalSealSchema.safeParse(body)
      if (!parsed.success) throw new Undeliverable('not a journal seal')
      const seal = parsed.data
      return this.seals.execute({
        sealId: seal.sealId,
        source: seal.source,
        tenantId: seal.tenantId,
        through: new Date(seal.through),
        count: seal.count,
        sealedAt: new Date(seal.sealedAt),
      })
    }
    return this.journal.execute(envelopeOf(body), 'replay')
  }
}
