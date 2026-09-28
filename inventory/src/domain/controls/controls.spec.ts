import { describe, expect, it } from 'vitest'
import { ApprovalDelegation, checkDuties, ownAuthority } from './approval-delegation'
import { DELEGABLE_PERMISSIONS } from './duties'

const now = new Date('2026-09-28T12:00:00.000Z')
const later = (days: number) => new Date(now.getTime() + days * 86_400_000)

function grant(overrides: Partial<Parameters<typeof ApprovalDelegation.grant>[0]> = {}) {
  return ApprovalDelegation.grant({
    tenantId: 't',
    permission: DELEGABLE_PERMISSIONS[0] ?? '',
    delegable: DELEGABLE_PERMISSIONS,
    delegatorId: 'approver',
    delegateId: 'stand-in',
    startsAt: now,
    endsAt: later(7),
    reason: null,
    now,
    ...overrides,
  })
}

describe('checkDuties', () => {
  it('refuses whoever did the work, in person or through a delegation', () => {
    const own = checkDuties('pair', ['clerk', null], ownAuthority('clerk'), 'no')
    expect(own.isLeft() && own.value.pair).toBe('pair')
    const lent = checkDuties(
      'pair',
      ['clerk'],
      { actor: 'stand-in', onBehalfOf: 'clerk', delegationId: 'd' },
      'no',
    )
    expect(lent.isLeft() && lent.value.message).toMatch(/through a delegation/)
    expect(
      checkDuties(
        'pair',
        ['clerk'],
        { actor: 'stand-in', onBehalfOf: 'approver', delegationId: 'd' },
        'no',
      ).isRight(),
    ).toBe(true)
  })
})

describe('an approval delegation', () => {
  it('lends only this module’s approvals, to someone else, for at most 90 days', () => {
    expect(grant().isRight()).toBe(true)
    expect(grant({ permission: 'sales:order:approve' }).isLeft()).toBe(true)
    expect(grant({ delegateId: 'approver' }).isLeft()).toBe(true)
    expect(grant({ endsAt: now }).isLeft()).toBe(true)
    expect(grant({ startsAt: later(-10), endsAt: later(-1) }).isLeft()).toBe(true)
    expect(grant({ endsAt: later(91) }).isLeft()).toBe(true)
  })

  it('gives authority only to its delegate, for its approval, while active', () => {
    const delegation = grant({ startsAt: later(1) }).value as ApprovalDelegation
    const permission = DELEGABLE_PERMISSIONS[0] ?? ''
    expect(delegation.stateAt(now)).toBe('scheduled')
    expect(delegation.authorityFor('stand-in', permission, now)).toBeNull()
    expect(delegation.authorityFor('stand-in', permission, later(2))).toMatchObject({
      actor: 'stand-in',
      onBehalfOf: 'approver',
    })
    expect(delegation.authorityFor('someone', permission, later(2))).toBeNull()
    expect(delegation.stateAt(later(8))).toBe('ended')
    expect(delegation.authorityFor('stand-in', permission, later(8))).toBeNull()
  })

  it('is revoked once, and then gives nothing', () => {
    const delegation = grant().value as ApprovalDelegation
    expect(delegation.revoke('approver', later(1)).isRight()).toBe(true)
    expect(delegation.stateAt(later(1))).toBe('revoked')
    expect(delegation.revoke('approver', later(1)).isLeft()).toBe(true)
    expect(delegation.authorityFor('stand-in', DELEGABLE_PERMISSIONS[0] ?? '', later(1))).toBeNull()
  })
})
