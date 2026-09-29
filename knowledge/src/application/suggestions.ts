import { rankSuggestions, type Suggestion, type SuggestionKind } from '@/domain/suggestions'
import { indexVersionOf } from './lexemes'
import type { Clock, Embedder, ReceivedEvent } from './ports'
import type { ExampleStore, NcmTable, PayableSource, SuggestionMetrics } from './suggestion-ports'

/** Nearest examples and official codes asked for, before the votes. */
export const EXAMPLES_ASKED = 10
export const CODES_ASKED = 5
/** Official codes embedded per batch while the table loads. */
export const TABLE_BATCH = 64

const clip = (text: string, length: number) => text.replace(/\s+/g, ' ').trim().slice(0, length)

/**
 * The confirmed history (Phase 77), from events: items named and classified in Catalog,
 * payables posted in Financial. Each becomes a vector with its label in its tenant's own
 * partition; a reversal or the supplier's erasure takes it out.
 */
export class ExampleIndex {
  constructor(
    private readonly store: ExampleStore,
    private readonly payables: PayableSource,
    private readonly embedder: Embedder,
    private readonly clock: Clock,
  ) {}

  private async vectorOf(text: string): Promise<number[]> {
    const [vector] = await this.embedder.embedDocuments([text])
    if (!vector) throw new Error('the embedder answered no vector')
    return vector
  }

  async itemCreated(
    event: ReceivedEvent,
    item: { itemId: string; name: string; sku: string; ncm: string | null },
  ): Promise<boolean> {
    return this.store.putExample(
      event,
      {
        kind: 'ncm',
        sourceId: item.itemId,
        label: item.ncm,
        partyId: null,
        reference: clip(`${item.name} (${item.sku})`, 240),
        embedding: await this.vectorOf(item.name),
        indexVersion: indexVersionOf(this.embedder),
      },
      this.clock.now(),
    )
  }

  itemClassified(
    event: ReceivedEvent,
    item: { itemId: string; ncm: string | null },
  ): Promise<boolean> {
    return this.store.relabel(event, 'ncm', item.itemId, item.ncm, this.clock.now())
  }

  /** A posted payable is read as a Financial viewer would read it, then indexed. */
  async payablePosted(event: ReceivedEvent, payable: { titleId: string }): Promise<boolean> {
    const detail = await this.payables.read(event.tenantId, payable.titleId)
    if (!detail?.categoryId) return false
    const text =
      clip(`${detail.partyName ?? ''} ${detail.description ?? ''}`, 1000) || detail.documentNumber
    return this.store.putExample(
      event,
      {
        kind: 'payable-category',
        sourceId: payable.titleId,
        label: detail.categoryId,
        partyId: detail.partyId,
        reference: clip(detail.documentNumber, 240),
        embedding: await this.vectorOf(text),
        indexVersion: indexVersionOf(this.embedder),
      },
      this.clock.now(),
    )
  }

  payableReversed(event: ReceivedEvent, payable: { titleId: string }): Promise<boolean> {
    return this.store.removeExample(event, 'payable-category', payable.titleId)
  }

  partyErased(event: ReceivedEvent, party: { partyId: string }): Promise<boolean> {
    return this.store.removeParty(event, party.partyId)
  }
}

/**
 * The official NCM table, embedded once for everyone (Phase 77). It loads again only when
 * the table's act or the embedder changes; a load that stopped midway starts over.
 */
export class NcmTableLoader {
  constructor(
    private readonly store: ExampleStore,
    private readonly embedder: Embedder,
    private readonly clock: Clock,
  ) {}

  async load(table: NcmTable): Promise<'current' | 'loaded'> {
    const indexVersion = indexVersionOf(this.embedder)
    const state = await this.store.tableState()
    if (
      state?.act === table.act &&
      state.indexVersion === indexVersion &&
      state.codes === table.codes.length
    )
      return 'current'
    await this.store.clearTable()
    for (let start = 0; start < table.codes.length; start += TABLE_BATCH) {
      const batch = table.codes.slice(start, start + TABLE_BATCH)
      const vectors = await this.embedder.embedDocuments(
        batch.map(([, description]) => description),
      )
      await this.store.insertCodes(
        batch.map(([code, description], index) => ({
          code,
          description,
          embedding: vectors[index] ?? [],
        })),
        indexVersion,
      )
    }
    await this.store.markTable(
      { act: table.act, indexVersion, codes: table.codes.length },
      this.clock.now(),
    )
    return 'loaded'
  }
}

export interface SuggestionAnswer {
  /** False when suggestions are off (no local model): the form shows nothing. */
  readonly available: boolean
  readonly suggestions: readonly Suggestion[]
}

/**
 * Suggestions for a person filling a form (Phase 77): votes of their own workspace's
 * confirmed examples, and, for an NCM, of the official table. They never write; a decision
 * is only counted.
 */
export class Suggestions {
  constructor(
    private readonly store: ExampleStore,
    private readonly embedder: Embedder,
    private readonly metrics: SuggestionMetrics,
    private readonly enabled: boolean,
  ) {}

  async suggest(
    tenantId: string,
    kind: SuggestionKind,
    text: string,
    partyId?: string,
  ): Promise<SuggestionAnswer> {
    if (!this.enabled) return { available: false, suggestions: [] }
    const started = performance.now()
    const vector = await this.embedder.embedQuery(text)
    const [examples, codes] = await Promise.all([
      this.store.nearestExamples(tenantId, kind, vector, EXAMPLES_ASKED),
      kind === 'ncm' ? this.store.nearestCodes(vector, CODES_ASKED) : Promise.resolve([]),
    ])
    const suggestions = rankSuggestions(examples, codes, {
      maxDistance: this.embedder.exampleDistance,
      maxCodeDistance: this.embedder.relevantDistance,
      partyId: partyId ?? null,
    })
    this.metrics.suggested(kind, (performance.now() - started) / 1000, suggestions.length)
    return { available: true, suggestions }
  }

  decide(kind: SuggestionKind, decision: 'accepted' | 'rejected'): void {
    this.metrics.decided(kind, decision)
  }
}
