/**
 * Suggestions while a form is filled (Phase 77). `knowledge` answers them from the
 * workspace's own confirmed history and, for an NCM, the official table; the web only shows
 * them, fills the field when one is accepted, and says which was accepted or rejected.
 */

export type SuggestionKind = 'ncm' | 'payable-category'

export type Suggestion = {
  value: string
  score: number
  description: string | null
  reason: {
    examples: { sourceId: string; reference: string; similarity: number; sameParty: boolean }[]
    officialTable: boolean
  }
}

export type SuggestionAnswer = { available: boolean; suggestions: Suggestion[] }

export const SUGGESTION_MIN_TEXT = 3
const TEXT_MAX = 500

/** The proxied suggestion route, or null while there is too little to ask about. */
export function suggestionPath(
  kind: SuggestionKind,
  text: string,
  partyId?: string,
): string | null {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length < SUGGESTION_MIN_TEXT) return null
  const query = new URLSearchParams({ text: trimmed.slice(0, TEXT_MAX) })
  if (partyId) query.set('partyId', partyId)
  return `/api/horizon/knowledge/suggestions/${kind}?${query.toString()}`
}

/** An NCM as people write it: `0901.21.00`. */
export function formatNcm(code: string): string {
  return /^\d{8}$/.test(code) ? `${code.slice(0, 4)}.${code.slice(4, 6)}.${code.slice(6)}` : code
}

/** The eight digits an NCM field accepts, however it was typed. */
export function ncmDigits(value: string): string {
  return value.replace(/\D/g, '')
}

/** Suggestions the form can show: known values only, and never the one already chosen. */
export function shownSuggestions(
  answer: SuggestionAnswer | null,
  options: {
    known?: (value: string) => boolean
    current?: string | null
    dismissed?: ReadonlySet<string>
  },
): Suggestion[] {
  if (!answer?.available) return []
  return answer.suggestions.filter(
    (suggestion) =>
      (options.known?.(suggestion.value) ?? true) &&
      suggestion.value !== options.current &&
      !options.dismissed?.has(suggestion.value),
  )
}
