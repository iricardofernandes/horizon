import { type Either, left, right } from '@/core/either'
import type { ImportLocale, ImportMapping, RowIssue } from './import-job'

/** One column an importer understands, and the headers that name it in a file. */
export interface ImportFieldSpec {
  readonly name: string
  readonly required: boolean
  readonly aliases: readonly string[]
  readonly description: string
}

export type ImportRecord = Readonly<Record<string, string | null>>

/** Case, accents, spaces and punctuation do not distinguish two headers. */
export function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** Each field takes the first column whose header is its name or one of its aliases. */
export function suggestMapping(
  fields: readonly ImportFieldSpec[],
  columns: readonly string[],
): ImportMapping {
  const byHeader = new Map(columns.map((column) => [normalizeHeader(column), column]))
  return Object.fromEntries(
    fields.map((field) => {
      const names = [field.name, ...field.aliases].map(normalizeHeader)
      const column = names.map((name) => byHeader.get(name)).find(Boolean)
      return [field.name, column ?? null]
    }),
  )
}

/** A mapping names only known fields and existing columns, and every required field. */
export function checkMapping(
  fields: readonly ImportFieldSpec[],
  columns: readonly string[],
  mapping: ImportMapping,
): Either<string, ImportMapping> {
  const known = new Set(fields.map((field) => field.name))
  for (const [field, column] of Object.entries(mapping)) {
    if (!known.has(field)) return left(`"${field}" is not a field of this import`)
    if (column !== null && !columns.includes(column))
      return left(`the file has no column "${column}"`)
  }
  const missing = fields.filter((field) => field.required && !mapping[field.name])
  if (missing.length > 0)
    return left(`map a column to ${missing.map((field) => field.name).join(', ')}`)
  return right(Object.fromEntries(fields.map((field) => [field.name, mapping[field.name] ?? null])))
}

/** A row's cells as the importer's fields; a blank cell is absent. */
export function recordOf(
  columns: readonly string[],
  mapping: ImportMapping,
  cells: readonly string[],
): ImportRecord {
  return Object.fromEntries(
    Object.entries(mapping).map(([field, column]) => {
      if (column === null) return [field, null]
      const value = cells[columns.indexOf(column)]?.trim() ?? ''
      return [field, value === '' ? null : value]
    }),
  )
}

/** A field's value in a record, or null when the row left it blank or it was not mapped. */
export const valueIn = (record: ImportRecord, field: string): string | null => record[field] ?? null

export const issue = (field: string | null, message: string): RowIssue => ({ field, message })

/**
 * A decimal written the locale's way, as a plain `1234.56`. Spreadsheet cells arrive
 * already plain, so an XLSX is always read as English.
 */
export function decimalOf(text: string, locale: ImportLocale): string | null {
  const compact = text.replace(/[\s ]/g, '')
  const plain =
    locale === 'pt-BR' ? compact.replaceAll('.', '').replace(',', '.') : compact.replaceAll(',', '')
  return /^-?\d+(\.\d+)?$/.test(plain) ? plain : null
}

const SPREADSHEET_EPOCH = Date.UTC(1899, 11, 30)
const DAY_MS = 86_400_000

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) return null
  if (date.getUTCDate() !== day) return null
  return date.toISOString().slice(0, 10)
}

/**
 * `YYYY-MM-DD`; `DD/MM/YYYY` in pt-BR or `MM/DD/YYYY` in English; or the day number a
 * spreadsheet stores a date cell as.
 */
export function dateOf(text: string, locale: ImportLocale): string | null {
  const trimmed = text.trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed)
  if (slashed) {
    const [first, second] = [Number(slashed[1]), Number(slashed[2])]
    return locale === 'pt-BR'
      ? isoDate(Number(slashed[3]), second, first)
      : isoDate(Number(slashed[3]), first, second)
  }
  if (/^\d{4,6}$/.test(trimmed)) {
    const serial = Number(trimmed)
    if (serial < 1 || serial > 2_958_465) return null
    return new Date(SPREADSHEET_EPOCH + serial * DAY_MS).toISOString().slice(0, 10)
  }
  return null
}

/** Several values in one cell, separated by `|`. */
export function listOf(text: string | null): string[] {
  if (text === null) return []
  return text
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}
