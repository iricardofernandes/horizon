import { makeRefreshTokenFamily } from '../../../test/factories/make-refresh-token-family'
import type { SessionLifetimes } from './refresh-token-family'

const startedAt = new Date('2026-09-10T12:00:00.000Z')
const timeAt = (milliseconds: number) => new Date(startedAt.getTime() + milliseconds)
const lifetimes: SessionLifetimes = {
  absoluteTtlSeconds: 60,
  idleTtlSeconds: 10,
  reuseGraceMs: 1000,
}

describe('RefreshTokenFamily', () => {
  it('rotates the token and returns the same sealed replacement during grace', () => {
    const family = makeRefreshTokenFamily()
    expect(
      family.rotateTo({ digest: 'next', sealedReplacement: 'sealed', now: timeAt(5000) }).isRight(),
    ).toBe(true)
    expect(family.isCurrent('initial-digest')).toBe(false)
    expect(family.isCurrent('next')).toBe(true)
    expect(family.wasRotatedFrom('initial-digest')).toBe(true)
    expect(family.graceReplacementFor('initial-digest', timeAt(5500), 1000)).toBe('sealed')
    expect(family.graceReplacementFor('initial-digest', timeAt(6000), 1000)).toBe('sealed')
    expect(family.graceReplacementFor('initial-digest', timeAt(6001), 1000)).toBeNull()
    expect(family.graceReplacementFor('unknown', timeAt(5500), 1000)).toBeNull()
  })

  it('only grants grace to the immediately previous token', () => {
    const family = makeRefreshTokenFamily()
    family.rotateTo({ digest: 'second', sealedReplacement: 'first-sealed', now: timeAt(100) })
    family.rotateTo({ digest: 'third', sealedReplacement: 'second-sealed', now: timeAt(200) })
    expect(family.graceReplacementFor('initial-digest', timeAt(300), 1000)).toBeNull()
    expect(family.graceReplacementFor('second', timeAt(300), 1000)).toBe('second-sealed')
    expect(family.wasRotatedFrom('initial-digest')).toBe(true)
    expect(family.wasRotatedFrom('second')).toBe(true)
    expect(family.wasRotatedFrom('unknown')).toBe(false)
  })

  it('expires exactly at the idle deadline', () => {
    const family = makeRefreshTokenFamily()
    expect(family.isExpiredAt(timeAt(9999), lifetimes)).toBe(false)
    expect(family.isExpiredAt(timeAt(10000), lifetimes)).toBe(true)
  })

  it('renews idle time without moving the absolute deadline', () => {
    const family = makeRefreshTokenFamily({ lastUsedAt: timeAt(55000) })
    family.rotateTo({ digest: 'next', sealedReplacement: 'sealed', now: timeAt(59000) })
    expect(family.isExpiredAt(timeAt(59999), lifetimes)).toBe(false)
    expect(family.isExpiredAt(timeAt(60000), lifetimes)).toBe(true)
    expect(family.remainingAbsoluteSeconds(timeAt(59000), 60)).toBe(1)
    expect(family.remainingAbsoluteSeconds(timeAt(50500), 60)).toBe(10)
  })

  it('kills a reused family, clears grace and emits a scoped security event', () => {
    const family = makeRefreshTokenFamily()
    family.rotateTo({ digest: 'next', sealedReplacement: 'sealed', now: timeAt(1000) })
    family.detectReuse(timeAt(3000))
    expect(family.isActive()).toBe(false)
    expect(family.graceReplacementFor('initial-digest', timeAt(3000), 10000)).toBeNull()
    expect(
      family
        .rotateTo({ digest: 'forbidden', sealedReplacement: 'sealed', now: timeAt(4000) })
        .isLeft(),
    ).toBe(true)
    expect(family.isCurrent('next')).toBe(true)
    const events = family.pullDomainEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.eventType).toBe('identity.session.reuse-detected')
    expect(events[0]?.payloadOf()).toEqual({
      tenantId: events[0]?.tenantId,
      userId: family.userId(),
      familyId: family.id.toString(),
      detectedAt: timeAt(3000).toISOString(),
    })
    expect(family.pullDomainEvents()).toEqual([])
  })

  it.each(['logout', 'user-disabled', 'expired'] as const)('ends a family for %s', (reason) => {
    const family = makeRefreshTokenFamily()
    family.rotateTo({ digest: 'next', sealedReplacement: 'sealed', now: timeAt(1000) })
    family.end(reason)
    expect(family.isActive()).toBe(false)
    expect(family.graceReplacementFor('initial-digest', timeAt(1100), 1000)).toBeNull()
    expect(
      family
        .rotateTo({ digest: 'forbidden', sealedReplacement: 'sealed', now: timeAt(1200) })
        .isLeft(),
    ).toBe(true)
    expect(family.hasPendingEvents).toBe(false)
  })
})
