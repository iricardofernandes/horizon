/**
 * The web side of cross-module reports (ADR 0058, ADR 0059; screens since Phase 70). Reporting
 * computes every figure; this only lays its answers out as tables and links.
 */

import type { RoleAssignment } from './navigation'

export const REPORTING_API = '/api/horizon/reporting'

export const EXPORT_FORMATS = ['csv', 'xlsx'] as const
export const EXPORT_LOCALES = ['pt-BR', 'en'] as const
export const CADENCES = ['daily', 'weekly', 'monthly'] as const

export type ReportCheck = { name: string; owner: string }

export type ReportCatalogEntry = {
  name: string
  sources: string[]
  checks: ReportCheck[]
  derived: { figure: string; from: string }[]
}

export type SourceState = { source: string; watermark: string | null; settled: boolean }

export type ReportFilter = { currency: string | null; from: string | null; to: string | null }

export type ReconciliationRun = {
  runId: string
  report: string
  cutoff: string
  outcome: 'matched' | 'different' | 'not-comparable'
  checks: { check: string; outcome: string }[]
  startedBy: string
  startedAt: string
}

export type ReportAnswer = {
  report: string
  cutoff: string
  settled: boolean
  sources: SourceState[]
  filter: ReportFilter
  data: unknown
  checks: ReportCheck[]
  reconciliation: ReconciliationRun | null
}

export type Dashboard = {
  cutoff: string
  reports: Record<string, { settled: boolean; headline: unknown }>
}

export type ExportJob = {
  jobId: string
  report: string
  cutoff: string
  format: 'csv' | 'xlsx'
  locale: string
  scheduleId: string | null
  status: 'requested' | 'running' | 'ready' | 'failed' | 'expired'
  settled: boolean | null
  rows: number | null
  bytes: number | null
  sha256: string | null
  failure: string | null
  requestedAt: string
  finishedAt: string | null
  expiresAt: string | null
}

export type ExportSchedule = {
  scheduleId: string
  report: string
  format: string
  locale: string
  cadence: string
  timeZone: string
  active: boolean
  nextDueAt: string | null
}

export type Cell = string
export type FigureTable = { key: string; columns: string[]; rows: Record<string, Cell>[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One row with nested objects spread as `parent.child` columns; lists are counted. */
export function flattenRow(value: Record<string, unknown>, prefix = ''): Record<string, Cell> {
  const row: Record<string, Cell> = {}
  for (const [key, entry] of Object.entries(value)) {
    const column = `${prefix}${key}`
    if (isRecord(entry)) Object.assign(row, flattenRow(entry, `${column}.`))
    else if (Array.isArray(entry)) row[column] = String(entry.length)
    else row[column] = entry === null || entry === undefined ? '' : String(entry)
  }
  return row
}

function tableOf(key: string, rows: Record<string, Cell>[]): FigureTable {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return { key, columns, rows }
}

/**
 * A report's figures as tables, whatever its shape: each list of records is a table, named by
 * its path; the loose values of an object are one row under that object's name.
 */
export function tablesOf(data: unknown, key = ''): FigureTable[] {
  if (Array.isArray(data)) {
    const records = data.filter(isRecord)
    return records.length
      ? [
          tableOf(
            key,
            records.map((record) => flattenRow(record)),
          ),
        ]
      : []
  }
  if (isRecord(data)) return objectTables(data, key)
  return data === null || data === undefined ? [] : [tableOf(key, [{ value: String(data) }])]
}

/** An object's loose values as one row, then a table for each structure inside it. */
function objectTables(data: Record<string, unknown>, key: string): FigureTable[] {
  const entries = Object.entries(data)
  const holdsTables = (value: unknown) =>
    Array.isArray(value) || (isRecord(value) && Object.values(value).some(isStructured))
  const loose = Object.fromEntries(entries.filter(([, value]) => !holdsTables(value)))
  const nested = entries
    .filter(([, value]) => holdsTables(value))
    .flatMap(([child, value]) => tablesOf(value, key ? `${key}.${child}` : child))
  const own = Object.keys(loose).length ? [tableOf(key, [flattenRow(loose)])] : []
  return [...own, ...nested]
}

function isStructured(value: unknown): boolean {
  return Array.isArray(value) || isRecord(value)
}

const AMOUNT_FIGURES = new Set([
  'amount',
  'balance',
  'outstanding',
  'overdue',
  'paid',
  'total',
  'value',
])

/**
 * Amounts travel as minor units in a row that names its currency; a column is an amount when
 * its last segment is one of Reporting's amount figures. Counts and ids never are.
 */
export function amountColumn(column: string): boolean {
  return AMOUNT_FIGURES.has(column.split('.').at(-1) ?? '')
}

/** The signed link Reporting hands out, read through the web's own API route. */
export function downloadPathOf(linkPath: string): string | null {
  if (!/^\/reporting\/exports\/[0-9a-f-]{36}\/file\?/.test(linkPath)) return null
  return `/api/horizon${linkPath}`
}

/** A file can be fetched while it is ready and not past its expiry. */
export function downloadable(job: ExportJob, now: Date): boolean {
  return job.status === 'ready' && job.expiresAt !== null && new Date(job.expiresAt) > now
}

/** A cutoff typed as a local date and time, as the instant the API wants. */
export function cutoffOf(typed: string): string | null {
  if (!typed) return null
  const instant = new Date(typed)
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString()
}

/** The query that asks a report at a cutoff with a filter; empty values are left out. */
export function reportQuery(cutoff: string | null, filter: Partial<ReportFilter>): string {
  const query = new URLSearchParams()
  if (cutoff) query.set('cutoff', cutoff)
  for (const key of ['currency', 'from', 'to'] as const) {
    const value = filter[key]?.trim()
    if (value) query.set(key, value)
  }
  return query.toString()
}

/**
 * What the person's Reporting roles allow, for showing actions only (ADR 0045); Reporting
 * still refuses what a role does not permit. A copy of its static role map.
 */
export function reportingAbilitiesOf(roles: readonly RoleAssignment[]) {
  const held = new Set(
    roles.filter((assignment) => assignment.module === 'reporting').map((entry) => entry.role),
  )
  const any = (...candidates: string[]) => candidates.some((role) => held.has(role))
  return {
    read: any('admin', 'analyst', 'viewer'),
    reconcile: any('admin', 'analyst'),
    export: any('admin', 'analyst', 'viewer'),
    schedule: any('admin', 'analyst'),
  }
}
