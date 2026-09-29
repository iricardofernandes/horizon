import { describe, expect, it } from 'vitest'
import {
  formatNcm,
  ncmDigits,
  type SuggestionAnswer,
  shownSuggestions,
  suggestionPath,
} from './suggestions'

const suggestion = (value: string) => ({
  value,
  score: 1,
  description: null,
  reason: { examples: [], officialTable: false },
})

describe('suggestions in forms (Phase 77)', () => {
  it('asks only once there is something to ask about', () => {
    expect(suggestionPath('ncm', ' ca ')).toBeNull()
    expect(suggestionPath('ncm', 'Café  torrado')).toBe(
      '/api/horizon/knowledge/suggestions/ncm?text=Caf%C3%A9+torrado',
    )
    expect(suggestionPath('payable-category', 'Aurora café', 'p1')).toBe(
      '/api/horizon/knowledge/suggestions/payable-category?text=Aurora+caf%C3%A9&partyId=p1',
    )
  })

  it('writes and reads an NCM as people do', () => {
    expect(formatNcm('09012100')).toBe('0901.21.00')
    expect(formatNcm('abc')).toBe('abc')
    expect(ncmDigits('0901.21.00')).toBe('09012100')
  })

  it('shows nothing while suggestions are off, and hides the unknown, the chosen and the dismissed', () => {
    const off: SuggestionAnswer = { available: false, suggestions: [suggestion('a')] }
    expect(shownSuggestions(off, {})).toEqual([])
    const on: SuggestionAnswer = {
      available: true,
      suggestions: ['a', 'b', 'c', 'd'].map(suggestion),
    }
    expect(
      shownSuggestions(on, {
        known: (value) => value !== 'd',
        current: 'a',
        dismissed: new Set(['b']),
      }).map((entry) => entry.value),
    ).toEqual(['c'])
    expect(shownSuggestions(null, {})).toEqual([])
  })
})
