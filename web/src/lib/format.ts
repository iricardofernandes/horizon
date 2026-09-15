/**
 * Presentation formatters. Money crosses the wire as minor units with an explicit
 * currency (ADR 0010); nothing here is allowed to invent a different representation.
 */
export function money(amount: string, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    Number(amount) / 100,
  )
}

export function compact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  )
}

export function dateOf(value: string): string {
  return new Date(value).toLocaleDateString()
}

export function dateTimeOf(value: string): string {
  return new Date(value).toLocaleString()
}

export function short(id: string): string {
  return id.slice(0, 8)
}

/** Parses a major-unit amount into the minor units the API expects, or null when malformed. */
export function minorUnits(value: string): string | null {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim())
  if (!match?.[1]) return null
  return `${match[1]}${(match[2] ?? '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '')
}
