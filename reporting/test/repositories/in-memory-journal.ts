import {
  type JournalScope,
  JournalStore,
  type RecordedSeal,
} from '@/application/ports/journal-store'
import type { JournalEntry, Source } from '@/domain/journal'

/** A tenant-scoped fake of the journal, for the unit tests (ADR 0014). */
export class InMemoryJournal extends JournalStore {
  readonly entries: (JournalEntry & { tenantId: string })[] = []
  readonly seals: (RecordedSeal & { tenantId: string })[] = []
  readonly watermarks = new Map<string, { through: Date; sealId: string }>()

  inTenant<T>(tenantId: string, work: (scope: JournalScope) => Promise<T>): Promise<T> {
    const key = (source: Source) => `${tenantId}:${source}`
    return work({
      append: async (entry) => {
        if (
          this.entries.some(
            (held) => held.source === entry.source && held.eventId === entry.eventId,
          )
        )
          return false
        this.entries.push({ ...entry, tenantId })
        return true
      },
      countThrough: async (source, through) =>
        this.entries.filter(
          (entry) =>
            entry.tenantId === tenantId &&
            entry.source === source &&
            entry.occurredAt.getTime() <= through.getTime(),
        ).length,
      recordSeal: async (seal) => {
        if (this.seals.some((held) => held.sealId === seal.sealId)) return false
        this.seals.push({ ...seal, tenantId })
        return true
      },
      watermark: async (source) => this.watermarks.get(key(source))?.through ?? null,
      setWatermark: async (source, through, sealId) => {
        this.watermarks.set(key(source), { through, sealId })
      },
    })
  }
}
