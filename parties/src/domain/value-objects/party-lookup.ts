/**
 * The normalized forms a duplicate check compares (ADR 0057).
 *
 * Without a document there is no uniqueness key, so the registry warns instead: two
 * parties whose names, emails or phones normalize to the same value are probably the same
 * one. The forms are deliberately coarse — "Acme Ltda." and "ACME" collide — because a
 * false warning costs a click and a missed duplicate costs a merge nobody can do yet.
 */
const COMPANY_SUFFIXES = new Set([
  'ltda',
  'sa',
  'me',
  'epp',
  'eireli',
  'mei',
  'inc',
  'llc',
  'ltd',
  'limited',
  'gmbh',
  'corp',
  'co',
  'srl',
  'sl',
  'bv',
  'ag',
  'plc',
])

export function lookupName(value: string): string | null {
  const words = value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\bs\s*\/\s*a\b/g, 'sa')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word && !COMPANY_SUFFIXES.has(word))
  return words.length ? words.join(' ') : null
}

export function lookupEmail(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized ? normalized : null
}

/** Digits only, without Brazil's country code, so "+55 11 9999-0000" meets "(11) 9999-0000". */
export function lookupPhone(value: string | null): string | null {
  const digits = value?.replace(/\D/g, '') ?? ''
  if (!digits) return null
  return digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits
}

export interface LookupProbe {
  readonly legalName: string
  readonly email: string | null
  readonly phone: string | null
}

export const LOOKUP_FIELDS = ['document', 'name', 'email', 'phone'] as const
export type LookupField = (typeof LOOKUP_FIELDS)[number]
