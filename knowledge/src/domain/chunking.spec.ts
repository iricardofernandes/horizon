import { describe, expect, it } from 'vitest'
import { chunkText, normalizeText } from './chunking'
import { afterFailure, retryDelayMs } from './documents'

describe('chunkText', () => {
  it('keeps a short text whole', () => {
    expect(chunkText('Nota fiscal de café')).toEqual({
      chunks: ['Nota fiscal de café'],
      truncated: false,
    })
  })

  it('cuts a long text on whitespace, with an overlap, and covers all of it', () => {
    const words = Array.from({ length: 600 }, (_, index) => `palavra${index}`).join(' ')
    const { chunks, truncated } = chunkText(words, 200, 40)
    expect(truncated).toBe(false)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200)
    for (const chunk of chunks) expect(chunk).toMatch(/^palavra\d+.*palavra\d+$/)
    expect(chunks.at(-1)).toContain('palavra599')
    expect(chunks.join(' ')).toContain('palavra300')
  })

  it('stops at the cap and says the rest was left out', () => {
    const { chunks, truncated } = chunkText('x '.repeat(10_000), 100, 10, 3)
    expect(chunks).toHaveLength(3)
    expect(truncated).toBe(true)
  })

  it('yields nothing from whitespace', () => {
    expect(chunkText(' \n\t ')).toEqual({ chunks: [], truncated: false })
  })

  it('folds whitespace and drops control characters', () => {
    expect(normalizeText('a\u0000b   c\n\n\n\nd')).toBe('a b c\n\nd')
  })
})

describe('retries', () => {
  it('backs off, and gives up after the last attempt', () => {
    expect(retryDelayMs(1)).toBe(30_000)
    expect(retryDelayMs(3)).toBe(120_000)
    expect(retryDelayMs(30)).toBe(3_600_000)
    expect(afterFailure(2)).toEqual({ state: 'pending', delayMs: 60_000 })
    expect(afterFailure(5)).toEqual({ state: 'failed', delayMs: null })
  })
})

it('refuses an overlap as long as the chunk', () => {
  expect(() => chunkText('texto', 100, 100)).toThrow()
})

it('breaks a line of one long word where it must', () => {
  const { chunks } = chunkText('a'.repeat(250), 100, 10)
  expect(chunks.join('').length).toBeGreaterThanOrEqual(250)
  for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100)
})
