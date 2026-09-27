import type { JournalEntry, Source } from '@/domain/journal'
import type { SealOutcome } from '@/domain/settlement'

export interface RecordedSeal {
  readonly sealId: string
  readonly source: Source
  readonly through: Date
  readonly producerCount: number
  readonly journalCount: number
  readonly outcome: SealOutcome
  readonly sealedAt: Date
  readonly receivedAt: Date
}

/** One tenant's journal, inside one transaction. */
export interface JournalScope {
  /** False when the event id is already held: the first copy is kept. */
  append(entry: JournalEntry): Promise<boolean>
  countThrough(source: Source, through: Date): Promise<number>
  /** False when the seal was already applied. */
  recordSeal(seal: RecordedSeal): Promise<boolean>
  watermark(source: Source): Promise<Date | null>
  setWatermark(source: Source, through: Date, sealId: string): Promise<void>
}

export abstract class JournalStore {
  abstract inTenant<T>(tenantId: string, work: (scope: JournalScope) => Promise<T>): Promise<T>
}

export interface Clock {
  now(): Date
}
