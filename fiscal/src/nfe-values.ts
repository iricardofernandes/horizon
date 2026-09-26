import { createHash } from 'node:crypto'

/** Value formatting shared by the model 55 and model 65 builders. */

/** A return is calculated as a reversal; the NF-e carries magnitudes and `finNFe` = 4. */
export function magnitude(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value
}

export function deterministicNumericCode(documentId: string): string {
  const value = createHash('sha256').update(documentId).digest().readUInt32BE(0) % 100_000_000
  return String(value).padStart(8, '0')
}

export function minorToDecimal(value: string): string {
  const fixed = minorToFixed(value)
  return fixed.replace(/\.00$/, '')
}

export function minorToFixed(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error('NF-e supports non-negative BRL amounts only')
  const padded = value.padStart(3, '0')
  return `${padded.slice(0, -2).replace(/^0+(?=\d)/, '')}.${padded.slice(-2)}`
}

export function decimal4(value: string): string {
  if (!/^\d+(?:\.\d{1,4})?$/.test(value)) throw new Error('NF-e quantity exceeds four decimals')
  const [integer, fraction = ''] = value.split('.')
  return `${integer}.${fraction.padEnd(4, '0')}`
}

export function percent(rate: { numerator: string; denominator: string }): string {
  const scaled = (BigInt(rate.numerator) * 1_000_000n) / BigInt(rate.denominator)
  return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, '0')}`
}

export function digits(value: string, length: number): string {
  const normalized = value.replace(/\D/g, '')
  if (normalized.length !== length) throw new Error('NF-e address code is invalid')
  return normalized
}

export function zonedInstant(instant: string, timezone: string): string {
  const date = new Date(instant)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
  const parts = formatter.formatToParts(date)
  const member = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value
  const offset = member('timeZoneName')?.replace('GMT', '')
  if (!offset || !/^[+-]\d{2}:\d{2}$/.test(offset)) throw new Error('NF-e timezone is invalid')
  return `${member('year')}-${member('month')}-${member('day')}T${member('hour')}:${member('minute')}:${member('second')}${offset}`
}
