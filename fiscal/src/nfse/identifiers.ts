/**
 * Identifiers of the national NFS-e (Anexo I). The DPS identifier is Horizon's: it is
 * bound before sending and is how a lost response is found again. The access key is the
 * authority's: only the national system generates it.
 */

/** `DPS` + issuing municipality (7) + inscription type (1) + inscription (14) + series (5) + number (15). */
export function buildDpsId(input: {
  municipalityCode: string
  cnpj: string
  series: number
  number: number
}): string {
  if (!/^\d{7}$/.test(input.municipalityCode)) throw new Error('DPS municipality is invalid')
  if (!/^\d{14}$/.test(input.cnpj)) throw new Error('DPS provider CNPJ is invalid')
  if (!Number.isInteger(input.series) || input.series < 1 || input.series > 49_999)
    throw new Error('DPS series is outside the taxpayer-application range')
  if (!Number.isInteger(input.number) || input.number < 1 || input.number > 999_999_999_999_999)
    throw new Error('DPS number is invalid')
  return `DPS${input.municipalityCode}2${input.cnpj}${String(input.series).padStart(5, '0')}${String(input.number).padStart(15, '0')}`
}

export function parseDpsId(dpsId: string): {
  municipalityCode: string
  inscriptionType: '1' | '2'
  inscription: string
  series: number
  number: number
} {
  const match = /^DPS(\d{7})([12])(\d{14})(\d{5})(\d{15})$/.exec(dpsId)
  if (!match) throw new Error('DPS identifier is invalid')
  const [, municipalityCode = '', inscriptionType, inscription = '', series = '', number = ''] =
    match
  return {
    municipalityCode,
    inscriptionType: inscriptionType as '1' | '2',
    inscription,
    series: Number(series),
    number: Number(number),
  }
}

/**
 * The 50-digit NFS-e access key: municipality (7), generating environment (1),
 * inscription type (1), inscription (14), NFS-e number (13), year and month (4), a
 * numeric code (9) and a check digit. Anexo I does not define the check digit; the
 * simulator uses modulo 11 like the NF-e key.
 */
export function buildNfseKey(input: {
  municipalityCode: string
  generatingEnvironment: '1' | '2'
  cnpj: string
  nfseNumber: number
  yearMonth: string
  numericCode: string
}): string {
  if (!/^\d{4}$/.test(input.yearMonth)) throw new Error('NFS-e key year-month is invalid')
  if (!/^\d{9}$/.test(input.numericCode)) throw new Error('NFS-e key code is invalid')
  const body = `${input.municipalityCode}${input.generatingEnvironment}2${input.cnpj}${String(input.nfseNumber).padStart(13, '0')}${input.yearMonth}${input.numericCode}`
  if (!/^\d{49}$/.test(body)) throw new Error('NFS-e key facts are invalid')
  return `${body}${modulo11(body)}`
}

export function isNfseKey(key: string): boolean {
  return /^\d{50}$/.test(key) && modulo11(key.slice(0, 49)) === key.at(-1)
}

function modulo11(body: string): string {
  let weight = 2
  let sum = 0
  for (const digit of [...body].reverse()) {
    sum += Number(digit) * weight
    weight = weight === 9 ? 2 : weight + 1
  }
  const rest = sum % 11
  return String(rest < 2 ? 0 : 11 - rest)
}
