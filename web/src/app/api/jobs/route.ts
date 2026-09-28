import { NextResponse } from 'next/server'
import { claimsOf, federatedJobs } from '@/lib/federation'
import { hostedDemoEnabled } from '@/lib/hosted-demo'
import { accessToken, authenticatedFetch } from '@/lib/session'

/** The job centre (Phase 66): the person's own imports, exports and runs, across modules. */
export async function GET() {
  const token = await accessToken()
  if (!token) return NextResponse.json({ message: 'Sign in again.' }, { status: 401 })
  if (hostedDemoEnabled()) return NextResponse.json({ jobs: [], sources: [] })
  const { roles, subject } = claimsOf(token)
  const answer = await federatedJobs(
    (path, signal) => authenticatedFetch(path, { signal }),
    roles,
    subject,
  )
  return NextResponse.json(answer, { headers: { 'cache-control': 'private, no-store' } })
}
