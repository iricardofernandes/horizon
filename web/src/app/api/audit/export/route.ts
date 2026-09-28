import { type NextRequest, NextResponse } from 'next/server'
import {
  AUDIT_EXPORT_LIMIT,
  type AuditEntry,
  auditCsvRow,
  auditFilterOf,
  auditSourcesFor,
  chosenSources,
  collectAudit,
  mergeEntries,
} from '@/lib/audit'
import { actorNames, rolesOf } from '@/lib/audit-server'
import { hostedDemoEnabled } from '@/lib/hosted-demo'
import { type ExportLocale, fileNameOf, toCsv } from '@/lib/list-export'
import { accessToken, authenticatedFetch } from '@/lib/session'

/**
 * The audit search as CSV (Phase 68, with the Phase 63 writer). Every page of every chosen
 * module is read with the person's own token, up to 50,000 rows in all; the header states
 * each module's chain verdict, so a file of a broken chain says so.
 */
export async function GET(request: NextRequest) {
  const token = await accessToken()
  if (!token) return NextResponse.json({ message: 'Sign in again.' }, { status: 401 })
  if (hostedDemoEnabled())
    return NextResponse.json({ message: 'Unknown API route.' }, { status: 404 })
  const roles = rolesOf(token)
  const search = request.nextUrl.searchParams
  const sources = chosenSources(auditSourcesFor(roles), search)
  if (sources.length === 0)
    return NextResponse.json({ message: 'No audit log can be read.' }, { status: 403 })
  const filter = auditFilterOf(search)
  const locale: ExportLocale = search.get('locale') === 'en' ? 'en' : 'pt-BR'
  const startedAt = new Date()
  const fetcher = (path: string, signal: AbortSignal) => authenticatedFetch(path, { signal })
  const entries: AuditEntry[] = []
  const verdicts: [string, string][] = []
  let truncated = false
  for (const source of sources) {
    const room = AUDIT_EXPORT_LIMIT - entries.length
    if (room <= 0) {
      truncated = true
      break
    }
    const collected = await collectAudit(fetcher, source, filter, room)
    entries.push(...collected.entries)
    truncated ||= collected.truncated
    verdicts.push([
      `chain.${source.module}`,
      collected.status !== 'ok'
        ? `unread (${collected.status})`
        : collected.broken.length
          ? `broken at ${collected.broken.join(' ')}`
          : 'intact',
    ])
  }
  const actors = await actorNames(roles)
  const csv = toCsv({
    metadata: [
      ['list', 'audit'],
      ['exported_at', startedAt.toISOString()],
      ['filter', new URLSearchParams(filter).toString() || 'none'],
      ['rows', String(entries.length)],
      ...verdicts,
      ...(truncated ? ([['truncated_at', String(AUDIT_EXPORT_LIMIT)]] as [string, string][]) : []),
    ],
    rows: mergeEntries(entries).map((entry) => auditCsvRow(entry, actors)),
    locale,
  })
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${fileNameOf(['audit'], startedAt)}"`,
      'cache-control': 'private, no-store',
    },
  })
}
