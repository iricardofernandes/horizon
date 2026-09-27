import { type Either, left, right } from '@/core/either'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

/**
 * Exports and their schedules (ADR 0059, Phase 63): what a file holds, how a cell is made
 * safe for a spreadsheet, and when a scheduled export is due.
 */
export const FORMATS = ['csv', 'xlsx'] as const
export type ExportFormat = (typeof FORMATS)[number]

export const LOCALES = ['pt-BR', 'en'] as const
export type ExportLocale = (typeof LOCALES)[number]

export const CADENCES = ['daily', 'weekly', 'monthly'] as const
export type Cadence = (typeof CADENCES)[number]

export type JobStatus = 'requested' | 'running' | 'ready' | 'failed' | 'expired'

/** A cell is text, a number, or empty. */
export type Cell = string | number | null

export interface Table {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly Cell[])[]
}

/** Characters that make a spreadsheet read a cell as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/

/** Text that could run as a formula is kept as text, with a leading apostrophe. */
export function neutralize(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text
}

const digitsCache = new Map<string, number>()

/** A currency's minor-unit digits, as the platform's own ISO 4217 data says. */
export function currencyDigits(currency: string): number {
  const cached = digitsCache.get(currency)
  if (cached !== undefined) return cached
  let digits = 2
  try {
    digits =
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
  } catch {
    digits = 2
  }
  digitsCache.set(currency, digits)
  return digits
}

/** Minor units as a decimal amount of the currency: `"123450"` BRL is `1234.5`. */
export function amountOf(minor: string, currency: string): number {
  const digits = currencyDigits(currency)
  const value = BigInt(minor)
  const scale = 10n ** BigInt(digits)
  const whole = value / scale
  const fraction = value % scale
  return Number(whole) + Number(fraction) / Number(scale)
}

export function isFormat(value: string): value is ExportFormat {
  return (FORMATS as readonly string[]).includes(value)
}

export function isCadence(value: string): value is Cadence {
  return (CADENCES as readonly string[]).includes(value)
}

/** An IANA timezone the platform knows. */
export function timeZoneOf(value: string): Either<InvalidInputError, string> {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return right(value)
  } catch {
    return left(new InvalidInputError('timeZone', 'must be an IANA timezone'))
  }
}

interface LocalDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

function localParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)
  const part = (type: string) => Number(parts.find((candidate) => candidate.type === type)?.value)
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
  }
}

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const local = localParts(new Date(instant), timeZone)
  const wall = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  )
  return wall - Math.floor(instant / 1000) * 1000
}

/** The instant a local date starts in a timezone, daylight saving included. */
export function startOfLocalDay(date: LocalDate, timeZone: string): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day)
  const first = wall - offsetAt(wall, timeZone)
  return new Date(wall - offsetAt(first, timeZone))
}

function isDueDay(cadence: Cadence, date: LocalDate): boolean {
  if (cadence === 'daily') return true
  if (cadence === 'monthly') return date.day === 1
  // Monday, whatever the zone: a calendar date's weekday is the zone's weekday.
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() === 1
}

/**
 * The first instant after `after` when a schedule is due: local midnight every day, on
 * Mondays, or on the 1st of the month, in the schedule's timezone.
 */
export function nextDue(cadence: Cadence, timeZone: string, after: Date): Date {
  const local = localParts(after, timeZone)
  for (let offset = 0; offset <= 32; offset += 1) {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day + offset))
    const date = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() }
    if (!isDueDay(cadence, date)) continue
    const due = startOfLocalDay(date, timeZone)
    if (due.getTime() > after.getTime()) return due
  }
  throw new Error('No due instant within 32 days')
}

/** The file name of an export: report, cutoff to the minute, format. */
export function fileNameOf(report: string, cutoff: Date, format: ExportFormat): string {
  const stamp = cutoff.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  return `${report}-${stamp}Z.${format}`
}
