import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HmacLexemeHasher } from './lexeme-hasher'

describe('the lexeme hasher (Phase 75)', () => {
  const master = randomBytes(32)
  const hasher = new HmacLexemeHasher(master)

  it('hashes a word alike within a tenant and differently in another', () => {
    const a = hasher.hash('tenant-a', 'contrat')
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(hasher.hash('tenant-a', 'contrat')).toBe(a)
    expect(hasher.hash('tenant-b', 'contrat')).not.toBe(a)
    expect(new HmacLexemeHasher(randomBytes(32)).hash('tenant-a', 'contrat')).not.toBe(a)
  })

  it('refuses a master key of another size', () => {
    expect(() => new HmacLexemeHasher(randomBytes(16))).toThrow()
  })
})
