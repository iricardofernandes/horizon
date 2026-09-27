import { describe, expect, it } from 'vitest'
import { documentOf, kindOfTaxId, maskedDocument, type Party, requiresContact } from './party'

describe('party kind inferred from Brazilian tax identifier', () => {
  it('recognizes numeric and alphanumeric CNPJs without discarding letters', () => {
    expect(kindOfTaxId('12.345.678/0001-95')).toBe('organization')
    expect(kindOfTaxId('00.000.000/E08G-12')).toBe('organization')
    expect(kindOfTaxId('123.456.789-01')).toBe('person')
  })
})

describe('typed party documents', () => {
  it('turns the form choice into the document the registry expects', () => {
    expect(documentOf('brazilian', { number: '12.345.678/0001-95', country: '' })).toEqual({
      type: 'cnpj',
      number: '12.345.678/0001-95',
    })
    expect(documentOf('brazilian', { number: '123.456.789-01', country: '' }).type).toBe('cpf')
    expect(documentOf('foreign', { number: 'HRB 1', country: 'de ' })).toEqual({
      type: 'foreign',
      country: 'DE',
      number: 'HRB 1',
    })
    expect(documentOf('none', { number: 'ignored', country: 'US' })).toEqual({ type: 'none' })
  })

  it('asks for contacts only for the roles that ship, bill or buy', () => {
    expect(requiresContact(['prospect', 'partner'])).toBe(false)
    expect(requiresContact(['prospect', 'customer'])).toBe(true)
  })

  it('masks a foreign document with its country and shows a dash when there is none', () => {
    const party = { document: { type: 'foreign', country: 'US', suffix: '6789' } } as Party
    expect(maskedDocument(party)).toBe('US •••• 6789')
    expect(
      maskedDocument({ document: { type: 'none', country: null, suffix: null } } as Party),
    ).toBe('—')
    expect(
      maskedDocument({ document: { type: 'cpf', country: null, suffix: '8901' } } as Party),
    ).toBe('•••• 8901')
  })
})
