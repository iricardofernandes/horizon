import { describe, expect, it } from 'vitest'
import { buildNfe55AccessKey, calculateNfeAccessKeyDigit, isValidNfeAccessKey } from './access-key'

describe('NF-e model 55 access key', () => {
  it('reproduces the modulo-11 vector published in MOC 7.0', () => {
    const publishedBase = '5206043300991100250655012000000780026730161'
    expect(calculateNfeAccessKeyDigit(publishedBase)).toBe(5)
    expect(isValidNfeAccessKey(`${publishedBase}5`)).toBe(true)
  })

  it('builds a stable PL 010f key for the approved alphanumeric issuer fixture', () => {
    const key = buildNfe55AccessKey({
      issuerUfCode: '35',
      issuedOn: '2026-09-22',
      issuerTaxId: '00.000.000/E08G-12',
      model: '55',
      series: 1,
      number: 1,
      emissionType: 1,
      numericCode: '12345678',
    })
    expect(key).toBe('35260900000000E08G12550010000000011123456783')
    expect(isValidNfeAccessKey(key)).toBe(true)
  })

  it('rejects mutations, lowercase letters and malformed field widths', () => {
    const key = '35260900000000E08G12550010000000011123456783'
    expect(isValidNfeAccessKey(`${key.slice(0, 42)}9${key.slice(43)}`)).toBe(false)
    expect(isValidNfeAccessKey(key.toLowerCase())).toBe(false)
    expect(() => calculateNfeAccessKeyDigit('1'.repeat(42))).toThrow('43 valid characters')
    expect(() =>
      buildNfe55AccessKey({
        issuerUfCode: '35',
        issuedOn: '2026-09-22',
        issuerTaxId: '00000000E08G12',
        model: '55',
        series: 1_000,
        number: 1,
        numericCode: '12345678',
      }),
    ).toThrow()
  })
})
