import { z } from 'zod'

const basePattern = /^[0-9]{6}[0-9A-Z]{12}[0-9]{25}$/
const keyPattern = /^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/

const inputSchema = z.object({
  issuerUfCode: z.string().regex(/^\d{2}$/),
  issuedOn: z.iso.date(),
  issuerTaxId: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase().replace(/[.\-/\s]/g, ''))
    .pipe(z.string().regex(/^[0-9A-Z]{12}[0-9]{2}$/)),
  model: z.literal('55'),
  series: z.number().int().min(0).max(999),
  number: z.number().int().min(1).max(999_999_999),
  emissionType: z.number().int().min(1).max(9).default(1),
  numericCode: z.string().regex(/^\d{8}$/),
})

export type Nfe55AccessKeyInput = z.input<typeof inputSchema>

/** Builds the PL 010f 44-character key, including alphanumeric CNPJ positions. */
export function buildNfe55AccessKey(input: Nfe55AccessKeyInput): string {
  const value = inputSchema.parse(input)
  const yearMonth = `${value.issuedOn.slice(2, 4)}${value.issuedOn.slice(5, 7)}`
  const base = [
    value.issuerUfCode,
    yearMonth,
    value.issuerTaxId,
    value.model,
    pad(value.series, 3),
    pad(value.number, 9),
    String(value.emissionType),
    value.numericCode,
  ].join('')
  return `${base}${calculateNfeAccessKeyDigit(base)}`
}

/**
 * Calculates modulo 11 from right to left with weights 2..9. For letters, NTC 2025.001
 * assigns the ASCII code minus 48 before weighting.
 */
export function calculateNfeAccessKeyDigit(base: string): number {
  if (!basePattern.test(base)) throw new Error('NF-e access-key base must have 43 valid characters')
  let weight = 2
  let sum = 0
  for (let index = base.length - 1; index >= 0; index -= 1) {
    const character = base[index]
    if (!character) throw new Error('NF-e access-key base is incomplete')
    sum += (character.charCodeAt(0) - 48) * weight
    weight = weight === 9 ? 2 : weight + 1
  }
  const remainder = sum % 11
  return remainder === 0 || remainder === 1 ? 0 : 11 - remainder
}

export function isValidNfeAccessKey(value: string): boolean {
  if (!keyPattern.test(value)) return false
  const base = value.slice(0, -1)
  return calculateNfeAccessKeyDigit(base) === Number(value.at(-1))
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0')
}
