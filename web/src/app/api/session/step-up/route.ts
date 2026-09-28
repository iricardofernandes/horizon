import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedFetch, replaceAccessToken } from '@/lib/session'

const stepUpSchema = z.strictObject({
  password: z.string().min(1).max(1024),
  method: z.enum(['totp', 'recovery']).optional(),
  code: z.string().min(6).max(20).optional(),
})
const answerSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.iso.datetime(),
})

/**
 * Proving again who one is before a sensitive action (Phase 67). The new access token, with
 * `auth_time` now, replaces the one in the cookie; the refresh token stays as it is.
 */
export async function POST(request: Request) {
  const parsed = stepUpSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ message: 'Check the fields.' }, { status: 400 })
  const response = await authenticatedFetch('/identity/auth/step-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parsed.data),
  })
  if (!response.ok)
    return new NextResponse(await response.arrayBuffer(), {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    })
  const answer = answerSchema.parse(await response.json())
  await replaceAccessToken(answer.accessToken, new Date(answer.accessTokenExpiresAt))
  return NextResponse.json({ steppedUp: true })
}
