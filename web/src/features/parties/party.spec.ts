import { describe, expect, it } from 'vitest'
import { kindOfTaxId } from './party'

describe('party kind inferred from Brazilian tax identifier', () => {
  it('recognizes numeric and alphanumeric CNPJs without discarding letters', () => {
    expect(kindOfTaxId('12.345.678/0001-95')).toBe('organization')
    expect(kindOfTaxId('00.000.000/E08G-12')).toBe('organization')
    expect(kindOfTaxId('123.456.789-01')).toBe('person')
  })
})
