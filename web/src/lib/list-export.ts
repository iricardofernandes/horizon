/**
 * List exports from the web server (Phase 63): the list's own API is paged as the
 * signed-in user and written as CSV. This file is pure, so the paging and the cells are
 * tested without a server.
 */

export const PAGE_SIZE = 200
export const ROW_LIMIT = 50_000
const PAGING_PARAMS = ['limit', 'offset', 'cursor', 'locale']

export type ExportLocale = 'pt-BR' | 'en'
export type Flat = Record<string, string | number | boolean | null>

/** The list's own query, without anything the exporter drives itself. */
export function listQuery(search: URLSearchParams): URLSearchParams {
  const query = new URLSearchParams()
  for (const [key, value] of search) if (!PAGING_PARAMS.includes(key)) query.append(key, value)
  return query
}

export interface Page {
  readonly rows: readonly unknown[]
  /** The query for the next page, or null when this was the last. */
  readonly next: URLSearchParams | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads one page in any of the paging styles the modules answer: offset with a total
 * (`page.total` or `total`), a cursor (`page.nextCursor`), or a bare array.
 */
export function pageOf(body: unknown, query: URLSearchParams): Page {
  if (Array.isArray(body)) return { rows: body, next: null }
  if (!isRecord(body) || !Array.isArray(body.data)) throw new Error('Not a list')
  const rows = body.data
  const page = isRecord(body.page) ? body.page : {}
  if (typeof page.nextCursor === 'string' && page.hasMore !== false) {
    const next = new URLSearchParams(query)
    next.set('cursor', page.nextCursor)
    return { rows, next }
  }
  const total =
    typeof page.total === 'number' ? page.total : typeof body.total === 'number' ? body.total : null
  const offset = Number(query.get('offset') ?? 0)
  const limit = Number(query.get('limit') ?? PAGE_SIZE)
  const more = total === null ? rows.length === limit : offset + rows.length < total
  if (!more || rows.length === 0) return { rows, next: null }
  const next = new URLSearchParams(query)
  next.set('offset', String(offset + rows.length))
  return { rows, next }
}

/** Nested objects become dotted columns; arrays stay whole, as JSON. */
export function flatten(value: unknown, prefix = '', into: Flat = {}): Flat {
  if (!isRecord(value)) {
    into[prefix || 'value'] = scalar(value)
    return into
  }
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key
    if (isRecord(child)) flatten(child, name, into)
    else into[name] = scalar(child)
  }
  return into
}

function scalar(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value
  return JSON.stringify(value)
}

/** Every column any row has, in the order they first appear. */
export function columnsOf(rows: readonly Flat[]): string[] {
  const seen = new Set<string>()
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key)
  return [...seen]
}

const FORMULA_START = /^[=+\-@\t\r]/

/** Text a spreadsheet could run as a formula is kept as text, with a leading apostrophe. */
export function neutralize(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text
}

function cell(value: string | number | boolean | null, locale: ExportLocale, separator: string) {
  if (value === null) return ''
  if (typeof value === 'number')
    return locale === 'pt-BR' ? String(value).replace('.', ',') : String(value)
  const raw = String(value)
  const text = neutralize(raw)
  const quoted = text !== raw || text.includes(separator) || /["\r\n]/.test(text)
  return quoted ? `"${text.replaceAll('"', '""')}"` : text
}

/** CSV with a BOM: `;` in pt-BR, `,` in English; metadata first, then the table. */
export function toCsv(input: {
  readonly metadata: readonly (readonly [string, string])[]
  readonly rows: readonly Flat[]
  readonly locale: ExportLocale
}): string {
  const separator = input.locale === 'pt-BR' ? ';' : ','
  const line = (cells: readonly (string | number | boolean | null)[]) =>
    cells.map((value) => cell(value, input.locale, separator)).join(separator)
  const columns = columnsOf(input.rows)
  const lines = [
    ...input.metadata.map(([key, value]) => line([key, value])),
    '',
    line(columns),
    ...input.rows.map((row) => line(columns.map((column) => row[column] ?? null))),
  ]
  return `﻿${lines.join('\r\n')}\r\n`
}

export function fileNameOf(path: readonly string[], at: Date): string {
  const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  return `${path.join('-').replace(/[^a-z0-9-]/gi, '')}-${stamp}Z.csv`
}
