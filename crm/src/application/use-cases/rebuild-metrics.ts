import { canonicalJson } from '@/core/audit/canonical-json'
import { metricRowsOf } from '@/domain/services/opportunity-metrics'
import type { CrmUnitOfWork } from '../ports/unit-of-work'

export interface RebuildProgress {
  /** Opportunities walked so far. */
  readonly processed: number
  /** Of those, how many had stored rows that differed from their history. */
  readonly drifted: number
}

export interface RebuildResult extends RebuildProgress {
  /** The first opportunities that drifted, to look at by hand. */
  readonly driftedIds: readonly string[]
  readonly rebuilt: boolean
}

const DRIFT_SAMPLE = 20

/**
 * Rebuild the forecast and pipeline-metric rows from the opportunity history (Phase 59).
 *
 * Opportunities are walked by id, one batch per transaction, each one locked while its rows
 * are compared with what its history says and replaced. A run can stop and start again at
 * any batch; `verifyOnly` compares without writing.
 */
export class RebuildMetricsUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly batchSize = 200,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
      throw new Error('Invalid rebuild batch size')
  }

  async execute(
    tenantId: string,
    options: {
      readonly verifyOnly?: boolean
      readonly onBatch?: (progress: RebuildProgress) => void
    } = {},
  ): Promise<RebuildResult> {
    let after: string | null = null
    let processed = 0
    const drifted: string[] = []
    for (;;) {
      const batch: { ids: readonly string[]; drifted: string[] } = await this.unitOfWork.inTenant(
        tenantId,
        async (scope) => {
          const ids = await scope.opportunities.idsAfter(after, this.batchSize)
          const changed: string[] = []
          for (const id of ids) {
            // Locks the opportunity, so a command on it waits for this comparison.
            if (!(await scope.opportunities.findById(id))) continue
            const expected = metricRowsOf(await scope.opportunities.history(id))
            const stored = await scope.metrics.stored(id)
            if (canonicalJson(stored) !== canonicalJson(expected)) changed.push(id)
            if (!options.verifyOnly) await scope.metrics.replace(id, expected)
          }
          return { ids, drifted: changed }
        },
      )
      if (!batch.ids.length) break
      processed += batch.ids.length
      drifted.push(...batch.drifted)
      after = batch.ids.at(-1) ?? null
      options.onBatch?.({ processed, drifted: drifted.length })
      if (batch.ids.length < this.batchSize) break
    }
    return {
      processed,
      drifted: drifted.length,
      driftedIds: drifted.slice(0, DRIFT_SAMPLE),
      rebuilt: !options.verifyOnly,
    }
  }
}
