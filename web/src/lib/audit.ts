/**
 * The audit screen (Phase 68). The web server reads each module's own audit log with the
 * signed-in person's token, within a budget, and merges the pages; there is no central copy
 * (ADR 0062). Each module judges its own page's chain, and the screen shows the verdict.
 * This file is pure, so the merge and the paging are tested without a server.
 */
import { SOURCE_BUDGET_MS, type SourceStatus } from './federation'
import type { RoleAssignment } from './navigation'

export const AUDIT_PAGE = 50
export const AUDIT_EXPORT_LIMIT = 50_000

export type AuditSource = {
  module: string
  path: string
  /** Who may read this log: `module:role` pairs, any one of which suffices. */
  readers: readonly string[]
}

const adminOf = (module: string): AuditSource => ({
  module,
  path: `/${module}/audit`,
  readers: [`${module}:admin`],
})

/** Every module that keeps an audit log. Parties and Webhooks keep none. */
export const AUDIT_SOURCES: readonly AuditSource[] = [
  { module: 'identity', path: '/identity/audit', readers: ['identity:owner', 'identity:admin'] },
  adminOf('catalog'),
  adminOf('sales'),
  adminOf('financial'),
  adminOf('treasury'),
  adminOf('ledger'),
  adminOf('procurement'),
  adminOf('inventory'),
  adminOf('fiscal'),
  adminOf('crm'),
  adminOf('reporting'),
  // Files holds no roles (ADR 0060): its log is the workspace administrators'.
  { module: 'files', path: '/files/audit', readers: ['identity:owner', 'identity:admin'] },
]

export function auditSourcesFor(roles: readonly RoleAssignment[]): AuditSource[] {
  const held = new Set(roles.map((role) => `${role.module}:${role.role}`))
  return AUDIT_SOURCES.filter((source) => source.readers.some((reader) => held.has(reader)))
}

export type AuditFilter = {
  actor?: string
  action?: string
  subjectType?: string
  subjectId?: string
  from?: string
  to?: string
}

const FILTER_KEYS = ['actor', 'action', 'subjectType', 'subjectId', 'from', 'to'] as const

/** The filter from a query string: bounded text, and instants for the period. */
export function auditFilterOf(search: URLSearchParams): AuditFilter {
  const filter: AuditFilter = {}
  for (const key of FILTER_KEYS) {
    const value = search.get(key)?.trim()
    if (!value) continue
    if (key === 'from' || key === 'to') {
      const instant = new Date(value)
      if (!Number.isNaN(instant.getTime())) filter[key] = instant.toISOString()
    } else filter[key] = value.slice(0, 200)
  }
  return filter
}

/** Which of the readable modules the person asked for; all of them when none is named. */
export function chosenSources(
  sources: readonly AuditSource[],
  search: URLSearchParams,
): AuditSource[] {
  const named = new Set(
    search
      .getAll('module')
      .flatMap((value) => value.split(','))
      .filter(Boolean),
  )
  return named.size === 0 ? [...sources] : sources.filter((source) => named.has(source.module))
}

export type AuditChain = { status: 'intact' | 'broken'; checked: number; broken: number[] }

export type AuditEntry = {
  module: string
  sequence: number
  occurredAt: string
  actor: string
  action: string
  subjectType: string
  subjectId: string
  requestId: string | null
  traceId: string | null
  details: Record<string, unknown> | null
  sealed?: boolean
  hash: string
}

export type AuditSourceReport = {
  module: string
  status: SourceStatus
  chain: AuditChain | null
  nextCursor: string | null
}

type Page = { entries: AuditEntry[]; chain: AuditChain; nextCursor: string | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A module's answer, read defensively: anything unexpected is that module's error. */
export function pageOf(module: string, body: unknown): Page | null {
  if (!isRecord(body) || !Array.isArray(body.data) || !isRecord(body.chain)) return null
  const chain = body.chain
  if (chain.status !== 'intact' && chain.status !== 'broken') return null
  const page = isRecord(body.page) ? body.page : {}
  const entries = body.data.filter(isRecord).map(
    (row): AuditEntry => ({
      module,
      sequence: Number(row.sequence),
      occurredAt: String(row.occurredAt),
      actor: String(row.actor),
      action: String(row.action),
      subjectType: String(row.subjectType),
      subjectId: String(row.subjectId),
      requestId: typeof row.requestId === 'string' ? row.requestId : null,
      traceId: typeof row.traceId === 'string' ? row.traceId : null,
      details: isRecord(row.details) ? row.details : null,
      ...(row.sealed === true ? { sealed: true } : {}),
      hash: String(row.hash),
    }),
  )
  return {
    entries,
    chain: {
      status: chain.status,
      checked: typeof chain.checked === 'number' ? chain.checked : entries.length,
      broken: Array.isArray(chain.broken) ? chain.broken.map(Number) : [],
    },
    nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null,
  }
}

export function auditPath(
  source: AuditSource,
  filter: AuditFilter,
  cursor: string | null,
  limit = AUDIT_PAGE,
): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) if (value) query.set(key, value)
  query.set('limit', String(limit))
  if (cursor) query.set('cursor', cursor)
  return `${source.path}?${query}`
}

export type Fetcher = (path: string, signal: AbortSignal) => Promise<Response>

async function askPage(
  fetcher: Fetcher,
  source: AuditSource,
  path: string,
  budgetMs: number,
): Promise<{ status: SourceStatus; page: Page | null }> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, budgetMs)
  try {
    const response = await fetcher(path, controller.signal)
    if (response.status === 401 || response.status === 403)
      return { status: 'forbidden', page: null }
    if (!response.ok) return { status: 'error', page: null }
    const page = pageOf(source.module, await response.json())
    return page ? { status: 'ok', page } : { status: 'error', page: null }
  } catch {
    return { status: timedOut ? 'timeout' : 'error', page: null }
  } finally {
    clearTimeout(timer)
  }
}

/** Newest first across modules; within a module, by its own sequence. */
export function mergeEntries(entries: readonly AuditEntry[]): AuditEntry[] {
  return [...entries].sort(
    (left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) ||
      left.module.localeCompare(right.module) ||
      right.sequence - left.sequence,
  )
}

/**
 * One page from every chosen module at once; a slow or broken module never holds up the
 * rest, and is named. `cursors` continues each module from where its last page ended; a
 * module whose cursor is `null` in a continuation has nothing more and is not asked.
 */
export async function federatedAudit(
  fetcher: Fetcher,
  sources: readonly AuditSource[],
  filter: AuditFilter,
  cursors: Readonly<Record<string, string | null>> | null = null,
  budgetMs = SOURCE_BUDGET_MS,
): Promise<{ entries: AuditEntry[]; sources: AuditSourceReport[] }> {
  const asked = cursors
    ? sources.filter((source) => typeof cursors[source.module] === 'string')
    : [...sources]
  const answers = await Promise.all(
    asked.map((source) =>
      askPage(
        fetcher,
        source,
        auditPath(source, filter, cursors?.[source.module] ?? null),
        budgetMs,
      ),
    ),
  )
  return {
    entries: mergeEntries(answers.flatMap((answer) => answer.page?.entries ?? [])),
    sources: asked.map((source, index) => {
      const answer = answers[index]
      return {
        module: source.module,
        status: answer?.status ?? 'error',
        chain: answer?.page?.chain ?? null,
        nextCursor: answer?.page?.nextCursor ?? null,
      }
    }),
  }
}

/** Every page of one module's log for the filter, up to the row limit, for an export. */
export async function collectAudit(
  fetcher: Fetcher,
  source: AuditSource,
  filter: AuditFilter,
  room: number,
): Promise<{ status: SourceStatus; entries: AuditEntry[]; broken: number[]; truncated: boolean }> {
  const entries: AuditEntry[] = []
  const broken: number[] = []
  let cursor: string | null = null
  for (;;) {
    const answer = await askPage(fetcher, source, auditPath(source, filter, cursor, 200), 10_000)
    if (!answer.page) return { status: answer.status, entries, broken, truncated: false }
    broken.push(...answer.page.chain.broken)
    const left = room - entries.length
    entries.push(...answer.page.entries.slice(0, left))
    if (answer.page.entries.length > left) return { status: 'ok', entries, broken, truncated: true }
    cursor = answer.page.nextCursor
    if (!cursor) return { status: 'ok', entries, broken, truncated: false }
  }
}

/** One CSV row per entry; the details stay whole, as JSON. */
export function auditCsvRow(
  entry: AuditEntry,
  actors: Readonly<Record<string, string>>,
): Record<string, string | number | null> {
  return {
    module: entry.module,
    sequence: entry.sequence,
    occurred_at: entry.occurredAt,
    actor: entry.actor,
    actor_name: actors[entry.actor] ?? null,
    action: entry.action,
    subject_type: entry.subjectType,
    subject_id: entry.subjectId,
    request_id: entry.requestId,
    details: entry.sealed ? '[sealed]' : entry.details ? JSON.stringify(entry.details) : null,
    hash: entry.hash,
  }
}
