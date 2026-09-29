/**
 * The full-text side of the index (Phase 75), over keyed lexemes: PostgreSQL stems a text,
 * each lexeme is replaced by a keyed hash, and only the hashes are stored, with their
 * positions. These are the pure parts: folding, and writing `tsvector` and `tsquery` text.
 */

/** The version of the lexical scheme, part of every index version. */
export const LEXICAL_VERSION = 'lex-v1'

/** At most this many positions per lexeme, as PostgreSQL keeps them. */
const MAX_POSITIONS = 256
/** PostgreSQL's highest position in a `tsvector`. */
const MAX_POSITION = 16_383
/** A question's distinct lexemes: more adds noise, not recall. */
export const MAX_QUERY_LEXEMES = 32

/** Accents folded and lower case, so "Café" and "cafe" stem alike in both languages. */
export function foldAccents(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

const HASH = /^[0-9a-f]{8,64}$/

function assertHash(hash: string): void {
  // Only hex reaches `tsvector` or `tsquery` text: nothing a parser could read otherwise.
  if (!HASH.test(hash)) throw new Error('a lexeme hash must be hex')
}

/** `hash:1,5 hash:3`, positions sorted, distinct and bounded as PostgreSQL keeps them. */
export function tsvectorOf(hashed: ReadonlyMap<string, readonly number[]>): string {
  return [...hashed.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hash, positions]) => {
      assertHash(hash)
      const kept = [
        ...new Set(positions.map((position) => Math.min(Math.max(position, 1), MAX_POSITION))),
      ]
        .sort((a, b) => a - b)
        .slice(0, MAX_POSITIONS)
      return kept.length ? `${hash}:${kept.join(',')}` : hash
    })
    .join(' ')
}

/** Any of the question's lexemes: `a | b | c`, or null when it has none. */
export function tsqueryOf(hashes: readonly string[]): string | null {
  const distinct = [...new Set(hashes)].slice(0, MAX_QUERY_LEXEMES)
  for (const hash of distinct) assertHash(hash)
  return distinct.length ? distinct.join(' | ') : null
}
