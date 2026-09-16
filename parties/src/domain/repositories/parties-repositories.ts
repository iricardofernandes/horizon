import type { DomainEvent } from '@/core/events/domain-event'
import type { Party } from '../entities/party'

export abstract class PartiesRepository {
  abstract findById(id: string): Promise<Party | null>
  /** Uniqueness is per tenant and answered through a keyed index, never the clear value. */
  abstract findByTaxId(taxId: string): Promise<Party | null>
  abstract create(party: Party): Promise<void>
  abstract save(party: Party): Promise<void>
}

/** Persists domain events to the outbox owned by the surrounding transaction. */
export abstract class PartyEventsRepository {
  abstract append(event: DomainEvent): Promise<void>
}
