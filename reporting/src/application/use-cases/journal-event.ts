import { type Arrival, journalEntryOf, type ReceivedEvent } from '@/domain/journal'
import type { JournalStore } from '../ports/journal-store'

export type JournalOutcome = 'journaled' | 'duplicate' | 'not-journaled'

/** Keeps an event, live or replayed, once (ADR 0058). */
export class JournalEventUseCase {
  constructor(private readonly store: JournalStore) {}

  async execute(event: ReceivedEvent, arrival: Arrival): Promise<JournalOutcome> {
    const entry = journalEntryOf(event, arrival)
    if (!entry) return 'not-journaled'
    const appended = await this.store.inTenant(entry.tenantId, (scope) => scope.append(entry))
    return appended ? 'journaled' : 'duplicate'
  }
}
