/** IBGE state codes used by NF-e `cUF`, access keys and municipality prefixes. */
export const UF_IBGE_CODES = {
  RO: '11',
  AC: '12',
  AM: '13',
  RR: '14',
  PA: '15',
  AP: '16',
  TO: '17',
  MA: '21',
  PI: '22',
  CE: '23',
  RN: '24',
  PB: '25',
  PE: '26',
  AL: '27',
  SE: '28',
  BA: '29',
  MG: '31',
  ES: '32',
  RJ: '33',
  SP: '35',
  PR: '41',
  SC: '42',
  RS: '43',
  MS: '50',
  MT: '51',
  GO: '52',
  DF: '53',
} as const

export type BrazilianUf = keyof typeof UF_IBGE_CODES

export function isBrazilianUf(value: string | null | undefined): value is BrazilianUf {
  return typeof value === 'string' && Object.hasOwn(UF_IBGE_CODES, value)
}

export function ufCodeOf(uf: string): string {
  if (!isBrazilianUf(uf)) throw new Error('Unknown Brazilian UF')
  return UF_IBGE_CODES[uf]
}

export function ufOfCode(code: string): BrazilianUf {
  const match = (Object.keys(UF_IBGE_CODES) as BrazilianUf[]).find(
    (uf) => UF_IBGE_CODES[uf] === code,
  )
  if (!match) throw new Error('Unknown IBGE state code')
  return match
}

export type FiscalJurisdiction = {
  uf: BrazilianUf
  ufCode: string
  municipalityCode: string
}

/**
 * Derives the fiscal jurisdiction from the registered address. The IBGE municipality
 * code must belong to the declared UF; a mismatch is a registration error, not a
 * choice between the two.
 */
export function jurisdictionOfAddress(address: {
  state: string | null
  municipalityCode: string | null
}): FiscalJurisdiction | null {
  if (!isBrazilianUf(address.state) || !address.municipalityCode) return null
  if (!/^\d{7}$/.test(address.municipalityCode)) return null
  const ufCode = UF_IBGE_CODES[address.state]
  if (!address.municipalityCode.startsWith(ufCode)) return null
  return { uf: address.state, ufCode, municipalityCode: address.municipalityCode }
}
