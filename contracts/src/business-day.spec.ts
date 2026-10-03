import { describe, expect, it } from 'vitest'

import { businessDayOf } from './business-day'

describe('the business day (Phase 92)', () => {
  it('is still today at 23:30 in Brasília, though already tomorrow in UTC', () => {
    // 23:30 on 30 September in São Paulo is 02:30 UTC on 1 October.
    const lateEvening = new Date('2026-10-01T02:30:00Z')
    expect(lateEvening.toISOString().slice(0, 10)).toBe('2026-10-01')
    expect(businessDayOf(lateEvening)).toBe('2026-09-30')
  })

  it('does not close a month early at 00:30 UTC on its last day', () => {
    const justPastMidnightUtc = new Date('2026-10-31T00:30:00Z')
    expect(businessDayOf(justPastMidnightUtc)).toBe('2026-10-30')
    expect(businessDayOf(new Date('2026-10-31T03:00:00Z'))).toBe('2026-10-31')
  })

  it('tells the day where the workspace says it is', () => {
    const instant = new Date('2026-10-01T02:30:00Z')
    expect(businessDayOf(instant, 'UTC')).toBe('2026-10-01')
    expect(businessDayOf(instant, 'Asia/Tokyo')).toBe('2026-10-01')
    expect(businessDayOf(instant, 'America/Manaus')).toBe('2026-09-30')
  })
})
