import { NextResponse } from 'next/server'
import { z } from 'zod'
import { gatewayFetch } from '@/lib/gateway'
import {
  clearMfaChallenge,
  clearWorkspaceSelection,
  mfaChallengeToken,
  storeWorkspaceSelection,
} from '@/lib/session'

const answerSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.enum(['totp', 'recovery']), code: z.string().min(6).max(20) }),
  z.strictObject({ method: z.literal('passkey-options') }),
  z.strictObject({ method: z.literal('passkey'), response: z.record(z.string(), z.unknown()) }),
])
const selectionSchema = z.object({
  selectionToken: z.string().min(1),
  selectionExpiresAt: z.iso.datetime(),
  workspaces: z.array(
    z.object({ tenantId: z.uuid(), slug: z.string().min(1), name: z.string().min(1) }),
  ),
})

function identity(path: string, body: unknown) {
  return gatewayFetch(`${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
}

/**
 * The second step of signing in (Phase 67): a TOTP or recovery code, or a passkey, against
 * the challenge the password step left in a cookie. On success the workspace choice follows.
 */
export async function POST(request: Request) {
  const parsed = answerSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ message: 'Check the code.' }, { status: 400 })
  const challengeToken = await mfaChallengeToken()
  if (!challengeToken) return NextResponse.json({ message: 'Sign in again.' }, { status: 401 })
  const answer = parsed.data
  if (answer.method === 'passkey-options') {
    const options = await identity('/auth/mfa/passkey/options', { challengeToken })
    return new NextResponse(await options.arrayBuffer(), {
      status: options.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  const response =
    answer.method === 'passkey'
      ? await identity('/auth/mfa/passkey', { challengeToken, response: answer.response })
      : await identity('/auth/mfa', { challengeToken, method: answer.method, code: answer.code })
  if (!response.ok) {
    if (response.status === 401 && answer.method === 'passkey') await clearMfaChallenge()
    return NextResponse.json(
      { message: response.status === 429 ? 'locked' : 'invalid' },
      { status: response.status },
    )
  }
  const selection = selectionSchema.parse(await response.json())
  await clearMfaChallenge()
  await clearWorkspaceSelection()
  await storeWorkspaceSelection(selection.selectionToken, new Date(selection.selectionExpiresAt))
  return NextResponse.json({ workspaces: selection.workspaces })
}
