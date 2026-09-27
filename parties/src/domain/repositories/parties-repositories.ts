import type { DomainEvent } from '@/core/events/domain-event'
import type { Party } from '../entities/party'
import type { LookupField, LookupProbe } from '../value-objects/party-lookup'
import type { PartyDocument } from '../value-objects/party-values'

export interface Lookalike {
  readonly party: Party
  readonly matchedOn: readonly LookupField[]
}

export abstract class PartiesRepository {
  abstract findById(id: string): Promise<Party | null>
  /**
   * Uniqueness is per tenant and answered through a keyed index, never the clear value.
   * A party without a document matches nothing.
   */
  abstract findByDocument(document: PartyDocument): Promise<Party | null>
  /**
   * Live parties whose normalized name, email, phone or document equal the probe's
   * (ADR 0057). Answered through keyed indexes, so no personal data is scanned in clear.
   */
  abstract findLookalikes(
    probe: LookupProbe & { readonly document: PartyDocument },
    limit: number,
  ): Promise<readonly Lookalike[]>
  /** Parties in id order after `afterId`, erased ones included, for tenant-wide passes. */
  abstract listAfter(afterId: string | null, limit: number): Promise<readonly Party[]>
  abstract create(party: Party): Promise<void>
  abstract save(party: Party): Promise<void>
}

/** Persists domain events to the outbox owned by the surrounding transaction. */
export abstract class PartyEventsRepository {
  abstract append(event: DomainEvent): Promise<void>
}
