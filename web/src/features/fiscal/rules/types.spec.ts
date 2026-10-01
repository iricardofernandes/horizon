import { describe, expect, it } from 'vitest'
import { changeActions, percentOf, ruleAbilitiesOf } from './types'

describe('the tax rules screen (Phase 88)', () => {
  it('lets an admin ask, and anyone with a deciding role be offered the decision', () => {
    expect(ruleAbilitiesOf([{ module: 'fiscal', role: 'admin' }])).toEqual({
      canRequest: true,
      canDecide: true,
    })
    // A delegate decides through a loan only Fiscal knows of, so the button is offered.
    expect(ruleAbilitiesOf([{ module: 'fiscal', role: 'issuer' }])).toEqual({
      canRequest: false,
      canDecide: true,
    })
    expect(ruleAbilitiesOf([{ module: 'fiscal', role: 'auditor' }]).canDecide).toBe(false)
  })

  it('never offers the requester the decision, only the cancellation', () => {
    const admin = { canRequest: true, canDecide: true }
    const pending = { status: 'pending' as const, requestedBy: 'ana' }
    expect(changeActions(pending, admin, 'ana')).toEqual({ decide: false, cancel: true })
    expect(changeActions(pending, admin, 'bruno')).toEqual({ decide: true, cancel: false })
    expect(changeActions({ ...pending, status: 'approved' }, admin, 'bruno')).toEqual({
      decide: false,
      cancel: false,
    })
  })

  it('shows an exact rate as a percentage', () => {
    expect(percentOf({ numerator: '9', denominator: '1000' })).toBe('0,9%')
    expect(percentOf({ numerator: '18', denominator: '100' })).toBe('18%')
    expect(percentOf({ numerator: '1', denominator: '3' })).toBe('33,3333%')
  })
})
