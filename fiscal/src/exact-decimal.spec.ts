import { describe, expect, it } from 'vitest'
import { decimal, multiply, roundHalfAwayFromZero } from './exact-decimal'

describe('exact decimal arithmetic', () => {
  it('multiplies without passing through IEEE-754 numbers', () => {
    expect(multiply(decimal('0.1'), decimal('0.2'))).toEqual({
      numerator: 1n,
      denominator: 50n,
    })
  })

  it('rounds halfway away from zero in both directions', () => {
    expect(roundHalfAwayFromZero({ numerator: 5n, denominator: 2n })).toBe(3n)
    expect(roundHalfAwayFromZero({ numerator: -5n, denominator: 2n })).toBe(-3n)
  })

  it('retains integer precision beyond Number.MAX_SAFE_INTEGER', () => {
    expect(roundHalfAwayFromZero(decimal('9007199254740993'))).toBe(9007199254740993n)
  })
})
