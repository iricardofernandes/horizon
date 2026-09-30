import { describe, expect, it } from 'vitest'
import { decimal, multiply, roundHalfAwayFromZero, roundHalfEven } from './exact-decimal'

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

  it('rounds halfway to even, as the official IBS/CBS calculator does', () => {
    // The calculator's own answers: 0.045 → 0.04, 0.135 → 0.14, 0.225 → 0.22, 0.495 → 0.50.
    expect(roundHalfEven(decimal('4.5'))).toBe(4n)
    expect(roundHalfEven(decimal('13.5'))).toBe(14n)
    expect(roundHalfEven(decimal('22.5'))).toBe(22n)
    expect(roundHalfEven(decimal('49.5'))).toBe(50n)
    expect(roundHalfEven(decimal('0.5'))).toBe(0n)
    expect(roundHalfEven(decimal('-2.5'))).toBe(-2n)
    expect(roundHalfEven(decimal('-3.5'))).toBe(-4n)
    expect(roundHalfEven(decimal('2.5000001'))).toBe(3n)
    expect(roundHalfEven(decimal('2.4999999'))).toBe(2n)
  })

  it('retains integer precision beyond Number.MAX_SAFE_INTEGER', () => {
    expect(roundHalfAwayFromZero(decimal('9007199254740993'))).toBe(9007199254740993n)
  })
})
