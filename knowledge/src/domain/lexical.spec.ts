import { describe, expect, it } from 'vitest'
import { foldAccents, MAX_QUERY_LEXEMES, tsqueryOf, tsvectorOf } from './lexical'

describe('keyed lexemes (Phase 75)', () => {
  it('folds accents and case, so both spellings stem alike', () => {
    expect(foldAccents('Café AÇÚCAR não')).toBe('cafe acucar nao')
  })

  it('writes a tsvector of hashes with sorted, distinct, bounded positions', () => {
    const text = tsvectorOf(
      new Map([
        ['bbbbbbbb', [3, 1, 3]],
        ['aaaaaaaa', [0, 20_000]],
        ['cccccccc', []],
      ]),
    )
    expect(text).toBe('aaaaaaaa:1,16383 bbbbbbbb:1,3 cccccccc')
  })

  it('writes any-of queries, and none for a question with no word', () => {
    expect(tsqueryOf(['aaaaaaaa', 'bbbbbbbb', 'aaaaaaaa'])).toBe('aaaaaaaa | bbbbbbbb')
    expect(tsqueryOf([])).toBeNull()
    const many = Array.from({ length: 50 }, (_, index) => index.toString(16).padStart(8, '0'))
    expect(tsqueryOf(many)?.split(' | ')).toHaveLength(MAX_QUERY_LEXEMES)
  })

  it('refuses anything but hex, so no word reaches the index text', () => {
    expect(() => tsvectorOf(new Map([["x' | y", [1]]]))).toThrow(/hex/)
    expect(() => tsqueryOf(['café'])).toThrow(/hex/)
  })
})
