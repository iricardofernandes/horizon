import { describe, expect, it } from 'vitest'
import { issuerRegimeOf } from './issuer-regime'

describe('the issuer regime a calculation reads', () => {
  it('is the NF-e CRT, with the income-tax regime of a normal issuer', () => {
    expect(issuerRegimeOf('lucro-real')).toEqual({
      regime: 'normal',
      incomeTaxRegime: 'lucro-real',
    })
    expect(issuerRegimeOf('lucro-presumido')).toEqual({
      regime: 'normal',
      incomeTaxRegime: 'lucro-presumido',
    })
    expect(issuerRegimeOf('simples-nacional')).toEqual({ regime: 'simples-nacional' })
    expect(issuerRegimeOf('mei')).toEqual({ regime: 'mei' })
  })

  it('is unknown for an issuer that has not declared one', () => {
    expect(issuerRegimeOf('not-declared')).toBeNull()
  })
})
