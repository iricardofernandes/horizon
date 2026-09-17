/**
 * A decimal amount as banks print it — `-1234.56`, `1.234,56`, `(12,00)` — into signed minor
 * units, assuming two decimals. Null when it is not a number.
 */
export function minorUnitsOf(text: string): bigint | null {
  let value = text.trim().replace(/\s/g, '').replace(/^R\$/i, '')
  let negative = false
  if (/^\(.*\)$/.test(value)) {
    negative = true
    value = value.slice(1, -1)
  }
  if (value.startsWith('-')) {
    negative = !negative
    value = value.slice(1)
  } else if (value.startsWith('+')) value = value.slice(1)
  const lastComma = value.lastIndexOf(',')
  const lastDot = value.lastIndexOf('.')
  const decimalAt = Math.max(lastComma, lastDot)
  let whole = value
  let fraction = ''
  if (decimalAt >= 0 && value.length - decimalAt - 1 <= 2 && value.length - decimalAt - 1 > 0) {
    whole = value.slice(0, decimalAt)
    fraction = value.slice(decimalAt + 1)
  }
  whole = whole.replace(/[.,]/g, '')
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) return null
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0')
  return negative ? -minor : minor
}

/** `20260915`, `20260915120000[-3:BRT]`, `15/09/2026` or `2026-09-15` as a calendar date. */
export function calendarDateOf(text: string): string | null {
  const value = text.trim()
  let year: string | undefined
  let month: string | undefined
  let day: string | undefined
  let match = /^(\d{4})(\d{2})(\d{2})/.exec(value)
  if (match) [, year, month, day] = match
  match = match ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match && !year) [, year, month, day] = match
  const brazilian = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value)
  if (brazilian) [, day, month, year] = brazilian
  if (!year || !month || !day) return null
  const iso = `${year}-${month}-${day}`
  const parsed = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso
}
