import { type NextRequest, NextResponse } from 'next/server'
import { claimsOf, federatedSearch } from '@/lib/federation'
import { hostedDemoEnabled } from '@/lib/hosted-demo'
import { accessToken, authenticatedFetch } from '@/lib/session'

/**
 * Federated search (Phase 66): every module the person can read, asked at once with their
 * own token and within a budget; the answer names any module that did not answer.
 */
export async function GET(request: NextRequest) {
  const token = await accessToken()
  if (!token) return NextResponse.json({ message: 'Sign in again.' }, { status: 401 })
  if (hostedDemoEnabled()) return NextResponse.json({ results: [], sources: [] })
  const term = (request.nextUrl.searchParams.get('q') ?? '').slice(0, 100)
  const answer = await federatedSearch(
    (path, signal) => authenticatedFetch(path, { signal }),
    claimsOf(token).roles,
    term,
  )
  return NextResponse.json(answer, { headers: { 'cache-control': 'private, no-store' } })
}
