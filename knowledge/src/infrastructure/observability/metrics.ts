import { metrics } from '@opentelemetry/api'
import type { IndexMetrics, SearchMetrics } from '@/application/ports'
import type { SuggestionMetrics } from '@/application/suggestion-ports'
import type { SuggestionKind } from '@/domain/suggestions'

const meter = metrics.getMeter('knowledge')

/** The index's service levels (Phase 74), with no tenant label. */
export class OtelIndexMetrics implements IndexMetrics, SearchMetrics, SuggestionMetrics {
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

  readonly #suggested = meter.createHistogram('knowledge_suggestion_seconds', {
    description: 'Time to answer one suggestion request, by kind',
    unit: 's',
  })
  readonly #decisions = meter.createCounter('knowledge_suggestion_decisions', {
    description:
      'Suggestions a person accepted or rejected, by kind: an acceptance rate, never a training set',
  })

  suggested(kind: SuggestionKind, seconds: number, count: number): void {
    this.#suggested.record(seconds, { kind, outcome: count > 0 ? 'ok' : 'empty' })
  }

  decided(kind: SuggestionKind, decision: 'accepted' | 'rejected'): void {
    this.#decisions.add(1, { kind, decision })
  }

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
