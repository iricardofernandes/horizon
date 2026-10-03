import { describe, expect, it } from 'vitest'
import { ExpiryDate } from './value-objects/tracking'

describe("a lot's expiry, by the workspace's day (Phase 92)", () => {
  const expiry = ExpiryDate.create('2026-09-30')
  if (expiry.isLeft()) throw expiry.value

  it('has not passed at 23:30 in Brasília on its last day, though UTC is a day ahead', () => {
    expect(expiry.value.hasPassed(new Date('2026-10-01T02:30:00Z'))).toBe(false)
  })

  it('has passed once the next day begins in Brasília', () => {
    expect(expiry.value.hasPassed(new Date('2026-10-01T03:00:00Z'))).toBe(true)
  })
})
