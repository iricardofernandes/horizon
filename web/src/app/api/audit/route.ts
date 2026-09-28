import { type NextRequest, NextResponse } from 'next/server'
import { auditFilterOf, auditSourcesFor, chosenSources, federatedAudit } from '@/lib/audit'
import { actorNames, rolesOf } from '@/lib/audit-server'
import { hostedDemoEnabled } from '@/lib/hosted-demo'
import { accessToken, authenticatedFetch } from '@/lib/session'

/**
 * The audit screen (Phase 68): a page from every module log the person may read, with each
 * module's chain verdict. `cursor.<module>` continues a module from its last page; in a
 * continuation, a module without one has nothing more and is not asked.
 */
export async function GET(request: NextRequest) {
  const token = await accessToken()
  if (!token) return NextResponse.json({ message: 'Sign in again.' }, { status: 401 })
  if (hostedDemoEnabled())
    return NextResponse.json({ entries: [], sources: [], readable: [], actors: {} })
  const roles = rolesOf(token)
  const readable = auditSourcesFor(roles)
  const search = request.nextUrl.searchParams
  const sources = chosenSources(readable, search)
  const continued = [...search.keys()].some((key) => key.startsWith('cursor.'))
  const cursors = continued
    ? Object.fromEntries(
        sources.map((source) => [source.module, search.get(`cursor.${source.module}`)]),
      )
    : null
  const [answer, actors] = await Promise.all([
    federatedAudit(
      (path, signal) => authenticatedFetch(path, { signal }),
      sources,
      auditFilterOf(search),
      cursors,
    ),
    actorNames(roles),
  ])
  return NextResponse.json(
    { ...answer, readable: readable.map((source) => source.module), actors },
    { headers: { 'cache-control': 'private, no-store' } },
  )
}
