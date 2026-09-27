import { describe, expect, it } from 'vitest'
import {
  advancedWatermark,
  isSettled,
  SEAL_MARGIN_MS,
  sealOutcome,
  settlementOf,
} from './settlement'

const at = (iso: string) => new Date(iso)

describe('seals and settlement', () => {
  const receivedAt = at('2026-09-27T12:10:00Z')

  it('matches a seal only when the journal holds exactly the producer count', () => {
    const through = at('2026-09-27T12:00:00Z')
    expect(sealOutcome({ through, receivedAt, producerCount: 3, journalCount: 3 })).toBe('matched')
    expect(sealOutcome({ through, receivedAt, producerCount: 3, journalCount: 2 })).toBe(
      'mismatched',
    )
    expect(sealOutcome({ through, receivedAt, producerCount: 2, journalCount: 3 })).toBe(
      'mismatched',
    )
  })

  it('refuses a seal inside the margin, which a late row could still outrun', () => {
    const through = new Date(receivedAt.getTime() - SEAL_MARGIN_MS + 1)
    expect(sealOutcome({ through, receivedAt, producerCount: 0, journalCount: 0 })).toBe('refused')
  })

  it('never moves a watermark back', () => {
    const later = at('2026-09-27T12:00:00Z')
    const earlier = at('2026-09-27T11:00:00Z')
    expect(advancedWatermark(null, earlier)).toBe(earlier)
    expect(advancedWatermark(later, earlier)).toBe(later)
    expect(advancedWatermark(earlier, later)).toBe(later)
  })

  it('settles a cutoff only when every source is proven complete through it', () => {
    const cutoff = at('2026-09-27T11:30:00Z')
    expect(isSettled(null, cutoff)).toBe(false)
    expect(isSettled(cutoff, cutoff)).toBe(true)
    const watermarks = new Map([
      ['sales', at('2026-09-27T12:00:00Z')],
      ['financial', at('2026-09-27T11:00:00Z')],
    ] as const)
    expect(settlementOf(watermarks, cutoff, ['sales'])).toEqual({ settled: true, unsettled: [] })
    expect(settlementOf(watermarks, cutoff, ['sales', 'financial'])).toEqual({
      settled: false,
      unsettled: ['financial'],
    })
    expect(settlementOf(watermarks, cutoff).unsettled).toContain('fiscal')
  })
})
