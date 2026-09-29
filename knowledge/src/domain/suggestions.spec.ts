import { describe, expect, it } from 'vitest'
import { OFFICIAL_WEIGHT, rankSuggestions } from './suggestions'

const example = (
  label: string,
  distance: number,
  extra: Partial<{ partyId: string; sourceId: string }> = {},
) => ({
  sourceId: extra.sourceId ?? `${label}-${distance}`,
  label,
  reference: `ref ${label}`,
  partyId: extra.partyId ?? null,
  distance,
})

describe('suggestions by weighted votes (Phase 77)', () => {
  it('lets the workspace’s own examples outvote the official table, and names both as reasons', () => {
    const ranked = rankSuggestions(
      [example('09012100', 0.1), example('09012100', 0.2), example('21011100', 0.3)],
      [
        { code: '09011110', description: 'Café não torrado', distance: 0.05 },
        { code: '09012100', description: 'Café torrado', distance: 0.1 },
      ],
      { maxDistance: 0.5 },
    )
    // 09011110 is only the table's: with an answer of its own, the workspace does not see it.
    expect(ranked.map((suggestion) => suggestion.value)).toEqual(['09012100', '21011100'])
    expect(ranked[0]).toMatchObject({
      description: 'Café torrado',
      reason: { officialTable: true, examples: [{ similarity: 0.9 }, { similarity: 0.8 }] },
    })
    expect(ranked[0]?.score).toBeCloseTo(0.9 + 0.8 + 0.9 * OFFICIAL_WEIGHT)
  })

  it('counts the same supplier first, and shows its payables first', () => {
    const ranked = rankSuggestions(
      [
        example('materia-prima', 0.2, { sourceId: 'a' }),
        example('manutencao', 0.3, { partyId: 'p1', sourceId: 'b' }),
      ],
      [],
      { maxDistance: 0.5, partyId: 'p1' },
    )
    expect(ranked.map((suggestion) => suggestion.value)).toEqual(['manutencao', 'materia-prima'])
    expect(ranked[0]?.reason.examples).toEqual([
      { sourceId: 'b', reference: 'ref manutencao', similarity: 0.7, sameParty: true },
    ])
  })

  it('never suggests what no neighbour near enough voted for, and at most three', () => {
    expect(
      rankSuggestions([example('x', 0.9)], [{ code: '1', description: 'd', distance: 0.95 }], {
        maxDistance: 0.5,
      }),
    ).toEqual([])
    const many = ['a', 'b', 'c', 'd'].map((label, index) => example(label, 0.1 * (index + 1)))
    expect(rankSuggestions(many, [], { maxDistance: 0.5 })).toHaveLength(3)
  })

  it('lets official codes vote from further away than the workspace’s own examples', () => {
    const ranked = rankSuggestions(
      [example('near', 0.05), example('far', 0.2)],
      [{ code: '73181500', description: 'Parafusos', distance: 0.2 }],
      { maxDistance: 0.1, maxCodeDistance: 0.25 },
    )
    expect(ranked.map((suggestion) => suggestion.value)).toEqual(['near'])
    const tableOnly = rankSuggestions(
      [example('far', 0.2)],
      [{ code: '73181500', description: 'Parafusos', distance: 0.2 }],
      {
        maxDistance: 0.1,
        maxCodeDistance: 0.25,
      },
    )
    expect(tableOnly).toMatchObject([
      { value: '73181500', reason: { examples: [], officialTable: true } },
    ])
  })

  it('keeps at most three reasons per value', () => {
    const five = [0.1, 0.2, 0.3, 0.35, 0.4].map((distance) => example('x', distance))
    expect(rankSuggestions(five, [], { maxDistance: 0.5 })[0]?.reason.examples).toHaveLength(3)
  })
})
