import { metrics } from '@opentelemetry/api'
import type { IndexMetrics, SearchMetrics } from '@/application/ports'

const meter = metrics.getMeter('knowledge')

/** The index's service levels (Phase 74), with no tenant label. */
export class OtelIndexMetrics implements IndexMetrics, SearchMetrics {
  readonly #embedding = meter.createHistogram('knowledge_embedding_seconds', {
    description: 'Time to embed one document',
    unit: 's',
  })
  readonly #settled = meter.createCounter('knowledge_documents_settled', {
    description: 'Documents that reached a state: indexed, no-text, pending (retry) or failed',
  })
  readonly #lag = meter.createGauge('knowledge_index_lag_seconds', {
    description: 'How long the oldest due document has waited',
    unit: 's',
  })

  readonly #search = meter.createHistogram('knowledge_search_seconds', {
    description: 'Time to answer one search, and whether it found anything',
    unit: 's',
  })

  searched(seconds: number, outcome: 'ok' | 'empty'): void {
    this.#search.record(seconds, { outcome })
  }

  embedded(seconds: number): void {
    this.#embedding.record(seconds)
  }

  settled(state: string): void {
    this.#settled.add(1, { state })
  }

  lag(seconds: number): void {
    this.#lag.record(seconds)
  }
}
