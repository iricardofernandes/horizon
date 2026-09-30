import { foldAccents, LEXICAL_VERSION, tsqueryOf, tsvectorOf } from '@/domain/lexical'
import type { Embedder, LexemeHasher, Lexicon } from './ports'

/**
 * What a chunk was indexed with: its embedder and the lexical scheme. A change to either
 * re-indexes every document in the background (ADR 0069).
 */
export const indexVersionOf = (embedder: Pick<Embedder, 'version'>) =>
  `${embedder.version}+${LEXICAL_VERSION}`

/**
 * What a document was indexed with: the above, and the key its lexemes were hashed under.
 * A new lexeme key re-indexes rather than leaving the words unfindable (Phase 81).
 */
export const documentIndexVersionOf = (
  embedder: Pick<Embedder, 'version'>,
  lexemes: Pick<Lexemes, 'keyId'>,
) => `${indexVersionOf(embedder)}+${lexemes.keyId}`

/**
 * Keyed lexemes (Phase 75): the stemming is PostgreSQL's, the key is the tenant's, and the
 * words themselves are never stored.
 */
export class Lexemes {
  constructor(
    private readonly lexicon: Lexicon,
    private readonly hasher: LexemeHasher,
  ) {}

  get keyId(): string {
    return this.hasher.keyId
  }

  /** One `tsvector` text per chunk, in order. */
  async ofChunks(tenantId: string, texts: readonly string[]): Promise<string[]> {
    const stemmed = await this.lexicon.lexemesOf(texts.map(foldAccents))
    return stemmed.map((lexemes) => {
      const hashed = new Map<string, number[]>()
      for (const [lexeme, positions] of lexemes) {
        const hash = this.hasher.hash(tenantId, lexeme)
        hashed.set(hash, [...(hashed.get(hash) ?? []), ...positions])
      }
      return tsvectorOf(hashed)
    })
  }

  /** The question as `tsquery` text, or null when it has no word left once stemmed. */
  async ofQuestion(tenantId: string, text: string): Promise<string | null> {
    const [lexemes] = await this.lexicon.lexemesOf([foldAccents(text)])
    return tsqueryOf(
      [...(lexemes?.keys() ?? [])].map((lexeme) => this.hasher.hash(tenantId, lexeme)),
    )
  }
}
