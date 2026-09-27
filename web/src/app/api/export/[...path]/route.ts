import { type NextRequest, NextResponse } from 'next/server'
import { hostedDemoEnabled } from '@/lib/hosted-demo'
import {
  type ExportLocale,
  type Flat,
  fileNameOf,
  flatten,
  listQuery,
  PAGE_SIZE,
  type Page,
  pageOf,
  ROW_LIMIT,
  toCsv,
} from '@/lib/list-export'
import { authenticatedFetch } from '@/lib/session'
import { buildUpstreamPath } from '@/lib/upstream-path'

type Failure = { status: number; message: string }
type Collected = { rows: Flat[]; truncated: boolean } | Failure

/** One page, as the signed-in user; the module's refusal is passed on. */
async function readPage(path: string[], query: URLSearchParams): Promise<Page | Failure> {
  const pathname = buildUpstreamPath(path, `?${query}`)
  if (!pathname) return { status: 404, message: 'Unknown API route.' }
  const response = await authenticatedFetch(pathname)
  if (!response.ok)
    return {
      status: response.status === 401 || response.status === 403 ? response.status : 502,
      message: 'The list could not be read for export.',
    }
  try {
    return pageOf(await response.json(), query)
  } catch {
    return { status: 400, message: 'This route is not a list.' }
  }
}

/** Every page of the list, up to the row limit. */
async function collect(path: string[], filter: URLSearchParams): Promise<Collected> {
  const rows: Flat[] = []
  let query: URLSearchParams | null = new URLSearchParams(filter)
  query.set('limit', String(PAGE_SIZE))
  while (query) {
    const page = await readPage(path, query)
    if ('status' in page) return page
    const room = ROW_LIMIT - rows.length
    rows.push(...page.rows.slice(0, room).map((row) => flatten(row)))
    if (page.rows.length > room) return { rows, truncated: true }
    query = page.next
  }
  return { rows, truncated: false }
}

/**
 * A list, as CSV (Phase 63). Every page is asked of the owning module with the signed-in
 * user's own token, so a user who cannot read the list gets the module's refusal, and no
 * file. The export stops at 50,000 rows and says so.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params
  if (hostedDemoEnabled() || !buildUpstreamPath(path))
    return NextResponse.json({ message: 'Unknown API route.' }, { status: 404 })
  const locale: ExportLocale = request.nextUrl.searchParams.get('locale') === 'en' ? 'en' : 'pt-BR'
  const filter = listQuery(request.nextUrl.searchParams)
  const startedAt = new Date()
  const collected = await collect(path, filter)
  if ('status' in collected)
    return NextResponse.json({ message: collected.message }, { status: collected.status })
  const { rows, truncated } = collected
  const csv = toCsv({
    metadata: [
      ['list', `/${path.join('/')}`],
      ['exported_at', startedAt.toISOString()],
      ['filter', filter.toString() || 'none'],
      ['rows', String(rows.length)],
      ...(truncated ? ([['truncated_at', String(ROW_LIMIT)]] as [string, string][]) : []),
    ],
    rows,
    locale,
  })
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${fileNameOf(path, startedAt)}"`,
      'cache-control': 'private, no-store',
    },
  })
}
