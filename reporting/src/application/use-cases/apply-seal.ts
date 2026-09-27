import { isJournaledSource } from '@/domain/journal'
import { advancedWatermark, type SealOutcome, sealOutcome } from '@/domain/settlement'
import type { Clock, JournalStore } from '../ports/journal-store'

export interface SealRequest {
  readonly sealId: string
  readonly source: string
  readonly tenantId: string
  readonly through: Date
  readonly count: number
  readonly sealedAt: Date
}

export interface SealResult {
  readonly outcome: SealOutcome | 'duplicate'
  readonly journalCount: number | null
}

/**
 * Compares a producer's count with the journal's, and moves the source's watermark only
 * when they agree (ADR 0058). Every seal is kept, so a mismatch stays visible.
 */
export class ApplySealUseCase {
  constructor(
    private readonly store: JournalStore,
    private readonly clock: Clock,
  ) {}

  async execute(seal: SealRequest): Promise<SealResult> {
    const source = seal.source
    if (!isJournaledSource(source)) return { outcome: 'refused', journalCount: null }
    const receivedAt = this.clock.now()
    return this.store.inTenant(seal.tenantId, async (scope) => {
      const journalCount = await scope.countThrough(source, seal.through)
      const outcome = sealOutcome({
        through: seal.through,
        receivedAt,
        producerCount: seal.count,
        journalCount,
      })
      const recorded = await scope.recordSeal({
        sealId: seal.sealId,
        source,
        through: seal.through,
        producerCount: seal.count,
        journalCount,
        outcome,
        sealedAt: seal.sealedAt,
        receivedAt,
      })
      if (!recorded) return { outcome: 'duplicate', journalCount }
      if (outcome === 'matched') {
        const current = await scope.watermark(source)
        const next = advancedWatermark(current, seal.through)
        if (next !== current) await scope.setWatermark(source, next, seal.sealId)
      }
      return { outcome, journalCount }
    })
  }
}
