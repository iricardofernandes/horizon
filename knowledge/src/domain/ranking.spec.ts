import { describe, expect, it } from 'vitest'
import { fuse, RRF_K } from './ranking'

const hit = (attachmentId: string, ordinal = 0) => ({ attachmentId, ordinal })

describe('reciprocal rank fusion (Phase 75)', () => {
  it('ranks first what both lists found, and names how each result was found', () => {
    const ranked = fuse(
      [
        { ...hit('a'), distance: 0.1 },
        { ...hit('b'), distance: 0.2 },
      ],
      [hit('b'), hit('c')],
      { maxDistance: 0.5, limit: 10 },
    )
    expect(ranked.map((entry) => entry.attachmentId)).toEqual(['b', 'a', 'c'])
    expect(ranked[0]?.matchedBy).toEqual(['meaning', 'words'])
    expect(ranked[0]?.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1))
  })

  it('orders the vector list by distance, whatever order the relaxed scan answered in', () => {
    const ranked = fuse(
      [
        { ...hit('far'), distance: 0.3 },
        { ...hit('near'), distance: 0.1 },
      ],
      [],
      { maxDistance: 0.5, limit: 10 },
    )
    expect(ranked.map((entry) => entry.attachmentId)).toEqual(['near', 'far'])
  })

  it('drops a chunk found only by a distant vector, but keeps it when its words match', () => {
    const vector = [
      { ...hit('noise'), distance: 0.9 },
      { ...hit('kept'), distance: 0.95 },
    ]
    expect(fuse(vector, [], { maxDistance: 0.5, limit: 10 })).toEqual([])
    expect(fuse(vector, [hit('kept')], { maxDistance: 0.5, limit: 10 })).toMatchObject([
      { attachmentId: 'kept', matchedBy: ['meaning', 'words'] },
    ])
  })

  it('keeps chunks of one file apart, and answers at most the limit', () => {
    const ranked = fuse([], [hit('a', 0), hit('a', 1), hit('b')], { maxDistance: 0.5, limit: 2 })
    expect(ranked.map((entry) => `${entry.attachmentId}:${entry.ordinal}`)).toEqual(['a:0', 'a:1'])
  })
})
