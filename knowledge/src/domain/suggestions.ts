/**
 * Suggestions (Phase 77): what the workspace already decided for similar things, and for an
 * NCM what the official table says, each voting for a value. Nothing here decides: a person
 * accepts or rejects what comes out, with its reason beside it.
 */
export const SUGGESTION_KINDS = ['ncm', 'payable-category'] as const
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number]

/** A confirmed example near the question. */
export interface ExampleNeighbour {
  readonly sourceId: string
  readonly label: string
  readonly reference: string
  readonly partyId: string | null
  readonly distance: number
}

/** An official NCM code near the question. */
export interface CodeNeighbour {
  readonly code: string
  readonly description: string
  readonly distance: number
}

export interface Suggestion {
  readonly value: string
  readonly score: number
  /** The official description of an NCM, when the table has it. */
  readonly description: string | null
  readonly reason: {
    /** The workspace's own examples that voted for it, nearest first. */
    readonly examples: readonly {
      readonly sourceId: string
      readonly reference: string
      readonly similarity: number
      readonly sameParty: boolean
    }[]
    /** Whether the official table voted for it. */
    readonly officialTable: boolean
  }
}

export const MAX_SUGGESTIONS = 3
const REASON_EXAMPLES = 3
/** The same supplier's payables speak louder than a similar description. */
export const SAME_PARTY_BONUS = 0.5
/** The official table counts, but less than what the workspace itself decided. */
export const OFFICIAL_WEIGHT = 0.5

const similarityOf = (distance: number) => Math.max(0, 1 - distance)

/**
 * Votes weighted by similarity, for neighbours within `maxDistance`; the best values, each
 * with its reason. A value no neighbour near enough voted for is never suggested, and when
 * the workspace's own examples answer, a value only the official table backs is left out:
 * the table is the fallback, not a rival.
 */
export function rankSuggestions(
  examples: readonly ExampleNeighbour[],
  codes: readonly CodeNeighbour[],
  options: {
    /** How near a confirmed example must be to vote. */
    readonly maxDistance: number
    /** How near an official code must be to vote; the table is a weaker, wider prior. */
    readonly maxCodeDistance?: number
    readonly partyId?: string | null
  },
): Suggestion[] {
  const votes = new Map<
    string,
    {
      score: number
      description: string | null
      examples: Suggestion['reason']['examples'][number][]
      official: boolean
    }
  >()
  const entry = (value: string) =>
    votes.get(value) ?? { score: 0, description: null, examples: [], official: false }
  for (const example of examples) {
    if (example.distance > options.maxDistance) continue
    const sameParty = Boolean(options.partyId) && example.partyId === options.partyId
    const current = entry(example.label)
    votes.set(example.label, {
      ...current,
      score: current.score + similarityOf(example.distance) + (sameParty ? SAME_PARTY_BONUS : 0),
      examples: [
        ...current.examples,
        {
          sourceId: example.sourceId,
          reference: example.reference,
          similarity: Number(similarityOf(example.distance).toFixed(3)),
          sameParty,
        },
      ],
    })
  }
  for (const code of codes) {
    if (code.distance > (options.maxCodeDistance ?? options.maxDistance)) continue
    const current = entry(code.code)
    votes.set(code.code, {
      ...current,
      score: current.score + similarityOf(code.distance) * OFFICIAL_WEIGHT,
      description: code.description,
      official: true,
    })
  }
  const ownAnswer = [...votes.values()].some((vote) => vote.examples.length > 0)
  return [...votes.entries()]
    .filter(([, vote]) => !ownAnswer || vote.examples.length > 0)
    .sort(([a, x], [b, y]) => y.score - x.score || a.localeCompare(b))
    .slice(0, MAX_SUGGESTIONS)
    .map(([value, vote]) => ({
      value,
      score: Number(vote.score.toFixed(4)),
      description: vote.description,
      reason: {
        examples: [...vote.examples]
          .sort((a, b) => Number(b.sameParty) - Number(a.sameParty) || b.similarity - a.similarity)
          .slice(0, REASON_EXAMPLES),
        officialTable: vote.official,
      },
    }))
}
