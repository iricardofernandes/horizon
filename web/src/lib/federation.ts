/**
 * Federated search and the job centre (Phase 66). The web server asks each module the
 * signed-in person can read, with their own token, each within a time budget; it shows
 * what answered and names what did not. Nothing is indexed centrally, and each module
 * still refuses what its roles do not allow.
 */
import type { RoleAssignment } from './navigation'

export const SOURCE_BUDGET_MS = 1500
export const SEARCH_MIN_LENGTH = 2

export type SourceStatus = 'ok' | 'timeout' | 'error' | 'forbidden'

export type SourceReport = { source: string; module: string; status: SourceStatus }

export type SearchResult = {
  source: string
  module: string
  id: string
  title: string
  subtitle: string | null
  href: string
}

export type JobItem = {
  source: string
  module: string
  id: string
  kind: string
  status: string
  done: number | null
  total: number | null
  startedAt: string | null
  finishedAt: string | null
  href: string
}

type Row = Record<string, unknown>

const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null)
const number = (value: unknown) => (typeof value === 'number' ? value : null)

export type SearchSource = {
  id: string
  module: string
  readRoles: readonly string[]
  path: (term: string) => string
  map: (row: Row) => SearchResult | null
}

const ANY_PARTIES = ['admin', 'editor', 'viewer']
const ANY_CATALOG = ['admin', 'editor', 'viewer']
const ANY_CRM = ['admin', 'manager', 'representative', 'viewer']
const ANY_FINANCIAL = ['admin', 'operator', 'viewer']

const titleSource = (direction: 'receivable' | 'payable'): SearchSource => ({
  id: `financial.${direction}s`,
  module: 'financial',
  readRoles: ANY_FINANCIAL,
  path: (term) => `/financial/${direction}s?search=${encodeURIComponent(term)}&limit=5`,
  map: (row) => {
    const id = text(row.id)
    const number = text(row.documentNumber)
    return id && number
      ? {
          source: `financial.${direction}s`,
          module: 'financial',
          id,
          title: number,
          subtitle: text(row.partyName),
          href: `/app/finance/${direction}s?open=${id}`,
        }
      : null
  },
})

export const SEARCH_SOURCES: readonly SearchSource[] = [
  {
    id: 'parties.parties',
    module: 'parties',
    readRoles: ANY_PARTIES,
    path: (term) => `/parties/parties?search=${encodeURIComponent(term)}&limit=5`,
    map: (row) => {
      const id = text(row.id)
      const name = text(row.legalName)
      return id && name
        ? {
            source: 'parties.parties',
            module: 'parties',
            id,
            title: name,
            subtitle: text(row.tradeName) ?? text(row.email),
            href: '/app/registrations/parties',
          }
        : null
    },
  },
  {
    id: 'catalog.items',
    module: 'catalog',
    readRoles: ANY_CATALOG,
    path: (term) => `/catalog/items?search=${encodeURIComponent(term)}&limit=5`,
    map: (row) => {
      const id = text(row.id)
      const name = text(row.name)
      return id && name
        ? {
            source: 'catalog.items',
            module: 'catalog',
            id,
            title: name,
            subtitle: text(row.sku),
            href: '/app/catalog/items',
          }
        : null
    },
  },
  {
    id: 'crm.accounts',
    module: 'crm',
    readRoles: ANY_CRM,
    path: (term) => `/crm/accounts?search=${encodeURIComponent(term)}`,
    map: (row) => {
      const id = text(row.id)
      const name = text(row.legalName)
      return id && name
        ? {
            source: 'crm.accounts',
            module: 'crm',
            id,
            title: name,
            subtitle: text(row.tradeName),
            href: `/app/crm/accounts?open=${id}`,
          }
        : null
    },
  },
  titleSource('receivable'),
  titleSource('payable'),
]

export type JobSource = {
  id: string
  module: string
  readRoles: readonly string[]
  path: string
  map: (row: Row) => JobItem | null
  /** Whose job it is, to keep only the reader's own. */
  ownerOf: (row: Row) => string | null
}

const importSource = (module: string): JobSource => ({
  id: `${module}.imports`,
  module,
  readRoles: ['admin'],
  path: `/${module}/imports`,
  ownerOf: (row) => text(row.requestedBy),
  map: (row) => {
    const id = text(row.id)
    const progress = (row.progress ?? {}) as Row
    const total = number(progress.total)
    const remaining = number(progress.remaining)
    return id
      ? {
          source: `${module}.imports`,
          module,
          id,
          kind: `import:${text(row.kind) ?? ''}`,
          status: text(row.status) ?? 'unknown',
          done: total !== null && remaining !== null ? total - remaining : null,
          total,
          startedAt: text(row.createdAt),
          finishedAt: text(row.finishedAt),
          href: `/app/administration/imports?module=${module}&job=${id}`,
        }
      : null
  },
})

export const JOB_SOURCES: readonly JobSource[] = [
  importSource('parties'),
  importSource('catalog'),
  importSource('inventory'),
  importSource('financial'),
  {
    id: 'reporting.exports',
    module: 'reporting',
    readRoles: ['admin', 'analyst', 'viewer'],
    path: '/reporting/exports?limit=20',
    ownerOf: (row) => text(row.requestedBy),
    map: (row) => {
      const id = text(row.jobId)
      return id
        ? {
            source: 'reporting.exports',
            module: 'reporting',
            id,
            kind: `export:${text(row.report) ?? ''}`,
            status: text(row.status) ?? 'unknown',
            done: number(row.rows),
            total: null,
            startedAt: text(row.requestedAt),
            finishedAt: text(row.finishedAt),
            href: '/app/jobs',
          }
        : null
    },
  },
  {
    id: 'sales.billing-runs',
    module: 'sales',
    readRoles: ['admin', 'representative', 'viewer'],
    path: '/sales/billing-runs',
    ownerOf: (row) => text(row.requestedBy),
    map: (row) => {
      const id = text(row.id)
      const totals = (row.totals ?? {}) as Row
      const counts = Object.values(totals).filter(
        (value): value is number => typeof value === 'number',
      )
      const total = counts.reduce((sum, value) => sum + value, 0)
      return id
        ? {
            source: 'sales.billing-runs',
            module: 'sales',
            id,
            kind: `billing-run:${text(row.competence) ?? ''}`,
            status: text(row.status) ?? 'unknown',
            done: total - (number(totals.pending) ?? 0),
            total,
            startedAt: text(row.startedAt),
            finishedAt: text(row.finishedAt),
            href: '/app/sales/billing',
          }
        : null
    },
  },
  {
    id: 'fiscal.imports',
    module: 'fiscal',
    readRoles: ['admin', 'reviewer'],
    path: '/fiscal/imports?limit=20',
    ownerOf: () => null,
    map: (row) => {
      const id = text(row.id)
      return id
        ? {
            source: 'fiscal.imports',
            module: 'fiscal',
            id,
            kind: 'supplier-invoice-import',
            status: text(row.status) ?? 'unknown',
            done: null,
            total: null,
            startedAt: text(row.importedAt),
            finishedAt: null,
            href: '/app/fiscal/inbound',
          }
        : null
    },
  },
]

/** The sources this person's roles can read: nothing else is ever asked. */
export function readable<S extends { module: string; readRoles: readonly string[] }>(
  sources: readonly S[],
  roles: readonly RoleAssignment[],
): S[] {
  return sources.filter((source) =>
    roles.some((role) => role.module === source.module && source.readRoles.includes(role.role)),
  )
}

/** The roles and subject a token carries, read without verifying: the modules verify. */
export function claimsOf(token: string | null): {
  subject: string | null
  roles: RoleAssignment[]
} {
  const part = token?.split('.')[1]
  if (!part) return { subject: null, roles: [] }
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
      sub?: unknown
      roles?: unknown
    }
    const roles = Array.isArray(claims.roles)
      ? claims.roles.filter(
          (role): role is RoleAssignment =>
            typeof role?.module === 'string' && typeof role?.role === 'string',
        )
      : []
    return { subject: typeof claims.sub === 'string' ? claims.sub : null, roles }
  } catch {
    return { subject: null, roles: [] }
  }
}

/** The rows of a list, whether the module answers `{ data: [...] }` or a bare array. */
export function rowsOf(body: unknown): Row[] {
  const rows = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data
  return Array.isArray(rows)
    ? rows.filter((row): row is Row => typeof row === 'object' && row !== null)
    : []
}

export type Fetcher = (path: string, signal: AbortSignal) => Promise<Response>

/** One source within its budget: its rows, or why there are none. */
export async function ask(
  fetcher: Fetcher,
  path: string,
  budgetMs = SOURCE_BUDGET_MS,
): Promise<{ status: SourceStatus; rows: Row[] }> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, budgetMs)
  try {
    const response = await fetcher(path, controller.signal)
    if (response.status === 401 || response.status === 403) return { status: 'forbidden', rows: [] }
    if (!response.ok) return { status: 'error', rows: [] }
    return { status: 'ok', rows: rowsOf(await response.json()) }
  } catch {
    return { status: timedOut ? 'timeout' : 'error', rows: [] }
  } finally {
    clearTimeout(timer)
  }
}

/** Every readable source at once; one slow or broken module never holds up the rest. */
export async function federatedSearch(
  fetcher: Fetcher,
  roles: readonly RoleAssignment[],
  term: string,
  budgetMs = SOURCE_BUDGET_MS,
): Promise<{ results: SearchResult[]; sources: SourceReport[] }> {
  const trimmed = term.trim()
  if (trimmed.length < SEARCH_MIN_LENGTH) return { results: [], sources: [] }
  const sources = readable(SEARCH_SOURCES, roles)
  const answers = await Promise.all(
    sources.map((source) => ask(fetcher, source.path(trimmed), budgetMs)),
  )
  return {
    results: answers.flatMap((answer, index) =>
      answer.rows
        .map((row) => sources[index]?.map(row) ?? null)
        .filter((result): result is SearchResult => result !== null)
        .slice(0, 5),
    ),
    sources: sources.map((source, index) => ({
      source: source.id,
      module: source.module,
      status: answers[index]?.status ?? 'error',
    })),
  }
}

/** The person's own jobs across modules, newest first. */
export async function federatedJobs(
  fetcher: Fetcher,
  roles: readonly RoleAssignment[],
  subject: string | null,
  budgetMs = SOURCE_BUDGET_MS,
): Promise<{ jobs: JobItem[]; sources: SourceReport[] }> {
  const sources = readable(JOB_SOURCES, roles)
  const answers = await Promise.all(sources.map((source) => ask(fetcher, source.path, budgetMs)))
  const jobs = answers.flatMap((answer, index) => {
    const source = sources[index]
    if (!source) return []
    return answer.rows
      .filter((row) => {
        const owner = source.ownerOf(row)
        return owner === null || owner === subject
      })
      .map((row) => source.map(row))
      .filter((job): job is JobItem => job !== null)
  })
  jobs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
  return {
    jobs,
    sources: sources.map((source, index) => ({
      source: source.id,
      module: source.module,
      status: answers[index]?.status ?? 'error',
    })),
  }
}
