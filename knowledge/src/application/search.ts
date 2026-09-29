import { scopeAllows } from '@horizon/contracts'
import { fuse, type MatchedBy } from '@/domain/ranking'
import {
  type AttachingModule,
  type RoleAssignment,
  readableModules,
  screenOf,
} from '@/domain/readers'
import type { Lexemes } from './lexemes'
import type { DocumentReference, Embedder, Sealer, SearchMetrics, SearchStore } from './ports'

/** Candidates each list takes before fusion. */
export const CANDIDATES = 40
export const DEFAULT_RESULTS = 10
export const MAX_RESULTS = 50

/** Who asks: their tenant, roles and, for a key's token, its scopes. */
export interface Caller {
  readonly tenantId: string
  readonly roles: readonly RoleAssignment[]
  readonly scopes?: readonly string[]
}

export interface SearchRequest {
  readonly text: string
  readonly limit?: number
  /** Only this record's attachments: the attachments panel's search. */
  readonly record?: Omit<DocumentReference, 'attachmentId'>
}

/** A result is a citation: where it is, what it belongs to, and what it says. */
export interface Citation {
  readonly attachmentId: string
  readonly record: {
    readonly module: string
    readonly recordType: string
    readonly recordId: string
  }
  /** The path of the record's screen in the web app. */
  readonly screen: string
  readonly position: { readonly chunk: number; readonly of: number }
  readonly excerpt: string
  readonly score: number
  readonly matchedBy: readonly MatchedBy[]
}

export interface SearchAnswer {
  readonly data: readonly Citation[]
  /** The modules searched: those whose attachments the caller can read. */
  readonly searched: readonly AttachingModule[]
}

/**
 * Search by meaning and by words (Phase 75). Both lists are asked only for the modules the
 * caller can read, inside their scans, so a chunk they cannot read never takes a place in a
 * ranking; what they cannot read answers exactly as what does not exist.
 */
export class Search {
  constructor(
    private readonly store: SearchStore,
    private readonly embedder: Embedder,
    private readonly lexemes: Lexemes,
    private readonly sealer: Sealer,
    private readonly metrics: SearchMetrics,
  ) {}

  async search(caller: Caller, request: SearchRequest): Promise<SearchAnswer> {
    const started = performance.now()
    const searched = readableModules(caller.roles, (module) =>
      scopeAllows(caller.scopes, module, 'GET'),
    )
    const answer = { data: await this.find(caller, request, searched), searched }
    this.metrics.searched((performance.now() - started) / 1000, answer.data.length ? 'ok' : 'empty')
    return answer
  }

  private async find(
    caller: Caller,
    request: SearchRequest,
    searched: readonly AttachingModule[],
  ): Promise<Citation[]> {
    const { record } = request
    const modules = record ? searched.filter((module) => module === record.module) : searched
    if (!modules.length) return []
    const [vector, words] = await Promise.all([
      this.embedder.embedQuery(request.text),
      this.lexemes.ofQuestion(caller.tenantId, request.text),
    ])
    const candidates = await this.store.candidates(caller.tenantId, {
      vector,
      words,
      modules,
      ...(record ? { record } : {}),
      depth: CANDIDATES,
    })
    const ranked = fuse(candidates.vector, candidates.words, {
      maxDistance: this.embedder.relevantDistance,
      limit: Math.min(request.limit ?? DEFAULT_RESULTS, MAX_RESULTS),
    })
    if (!ranked.length) return []
    const stored = await this.store.chunksOf(caller.tenantId, ranked, modules)
    const byKey = new Map(stored.map((chunk) => [`${chunk.attachmentId}:${chunk.ordinal}`, chunk]))
    return ranked.flatMap((hit) => {
      // Gone since the ranking (erased meanwhile): no source, so no result.
      const chunk = byKey.get(`${hit.attachmentId}:${hit.ordinal}`)
      if (!chunk) return []
      return [
        {
          attachmentId: chunk.attachmentId,
          record: { module: chunk.module, recordType: chunk.recordType, recordId: chunk.recordId },
          screen: screenOf(chunk.module, chunk.recordType, chunk.recordId),
          position: { chunk: chunk.ordinal + 1, of: chunk.of },
          excerpt: this.sealer.open(
            chunk.wrappedKey,
            caller.tenantId,
            chunk.attachmentId,
            chunk.ordinal,
            chunk.sealedText,
          ),
          score: Number(hit.score.toFixed(6)),
          matchedBy: hit.matchedBy,
        },
      ]
    })
  }
}
