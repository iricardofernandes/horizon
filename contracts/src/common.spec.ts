import { describe, expect, it } from 'vitest'

import { moneySchema, quantitySchema } from './common'

describe('money', () => {
  it('accepts integer minor units as a string', () => {
    expect(moneySchema.safeParse({ amount: '123456', currency: 'BRL' }).success).toBe(true)
  })

  it('accepts a negative amount', () => {
    // Credits, reversals and adjustments are legitimate.
    expect(moneySchema.safeParse({ amount: '-500', currency: 'USD' }).success).toBe(true)
  })

  it('rejects a decimal', () => {
    // The entire point of the representation: an amount is a count of minor units, so
    // "12.34" means the producer is thinking in major units and will eventually be off
    // by a factor of a hundred.
    expect(moneySchema.safeParse({ amount: '12.34', currency: 'BRL' }).success).toBe(false)
  })

  it('rejects a JSON number', () => {
    // A number loses precision above 2^53, which is what the string encoding prevents.
    expect(moneySchema.safeParse({ amount: 123456, currency: 'BRL' }).success).toBe(false)
  })

  it('rejects a lowercase or malformed currency', () => {
    expect(moneySchema.safeParse({ amount: '1', currency: 'brl' }).success).toBe(false)
    expect(moneySchema.safeParse({ amount: '1', currency: 'BRLX' }).success).toBe(false)
  })

  it('requires an explicit currency', () => {
    // An amount without a currency is not a quantity of money.
    expect(moneySchema.safeParse({ amount: '1' }).success).toBe(false)
  })
})

describe('quantity', () => {
  it('accepts an integer and a bounded decimal', () => {
    expect(quantitySchema.safeParse('10').success).toBe(true)
    expect(quantitySchema.safeParse('10.500000').success).toBe(true)
  })

  it('rejects more than six decimal places', () => {
    expect(quantitySchema.safeParse('10.5000001').success).toBe(false)
  })

  it('rejects a negative quantity', () => {
    expect(quantitySchema.safeParse('-1').success).toBe(false)
  })
})
