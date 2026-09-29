import { createHash } from 'node:crypto'
import { Lexemes } from '@/application/lexemes'
import { LexemeHasher, Lexicon } from '@/application/ports'

/** Words as lexemes, with their positions: PostgreSQL's stemming, without PostgreSQL. */
export class FakeLexicon extends Lexicon {
  async lexemesOf(texts: readonly string[]) {
    return texts.map((text) => {
      const lexemes = new Map<string, number[]>()
      const words = text.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2)
      for (const [index, word] of words.entries())
        lexemes.set(word, [...(lexemes.get(word) ?? []), index + 1])
      return lexemes
    })
  }
}

/** A hash that still names its tenant, so a test can see which key was used. */
export class FakeHasher extends LexemeHasher {
  hash(tenantId: string, lexeme: string) {
    return createHash('sha256').update(`${tenantId}|${lexeme}`).digest('hex').slice(0, 16)
  }
}

export const fakeLexemes = () => new Lexemes(new FakeLexicon(), new FakeHasher())
