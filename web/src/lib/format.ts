/**
 * Locale-independent helpers. Anything a reader sees formatted — money, quantities,
 * dates — goes through `lib/use-format.ts`, which knows the active locale (ADR 0044).
 */
export function short(id: string): string {
  return id.slice(0, 8)
}

/** Parses a major-unit amount into the minor units the API expects, or null when malformed. */
export function minorUnits(value: string): string | null {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim())
  if (!match?.[1]) return null
  return `${match[1]}${(match[2] ?? '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '')
}
