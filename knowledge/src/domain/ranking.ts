/**
 * Ranking a hybrid search (Phase 75): the vector list and the full-text list merged by
 * reciprocal rank, so neither score's scale has to be compared with the other's.
 */
export interface ChunkKey {
  readonly attachmentId: string
  readonly ordinal: number
}

export interface VectorHit extends ChunkKey {
  readonly distance: number
}

export type MatchedBy = 'meaning' | 'words'

export interface Ranked extends ChunkKey {
  readonly score: number
  readonly matchedBy: readonly MatchedBy[]
}

/** The usual constant of reciprocal rank fusion: later ranks still count, but less. */
export const RRF_K = 60

const keyOf = (hit: ChunkKey) => `${hit.attachmentId}:${hit.ordinal}`

/**
 * Both lists merged: each chunk scores `1 / (k + rank)` in every list it is in. A chunk
 * found only by its vector must be within `maxDistance`, so a question that means nothing
 * in the tenant answers nothing rather than its least distant chunks.
 */
export function fuse(
  vector: readonly VectorHit[],
  words: readonly ChunkKey[],
  options: { readonly maxDistance: number; readonly limit: number; readonly k?: number },
): Ranked[] {
  const k = options.k ?? RRF_K
  const inWords = new Set(words.map(keyOf))
  const merged = new Map<string, { key: ChunkKey; score: number; matchedBy: MatchedBy[] }>()
  const add = (hit: ChunkKey, rank: number, by: MatchedBy) => {
    const entry = merged.get(keyOf(hit)) ?? {
      key: { attachmentId: hit.attachmentId, ordinal: hit.ordinal },
      score: 0,
      matchedBy: [],
    }
    merged.set(keyOf(hit), {
      ...entry,
      score: entry.score + 1 / (k + rank),
      matchedBy: [...entry.matchedBy, by],
    })
  }
  const near = [...vector]
    .sort((a, b) => a.distance - b.distance)
    .filter((hit) => hit.distance <= options.maxDistance || inWords.has(keyOf(hit)))
  for (const [index, hit] of near.entries()) add(hit, index + 1, 'meaning')
  for (const [index, hit] of words.entries()) add(hit, index + 1, 'words')
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || keyOf(a.key).localeCompare(keyOf(b.key)))
    .slice(0, options.limit)
    .map((entry) => ({ ...entry.key, score: entry.score, matchedBy: entry.matchedBy }))
}
