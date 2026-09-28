import { NextResponse } from 'next/server'
import { z } from 'zod'
import { clearEnrollment, enrollmentToken } from '@/lib/session'

const apiUrl = process.env.HORIZON_API_URL ?? 'http://localhost:8000'

const actionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({
    action: z.literal('confirm'),
    factorId: z.uuid(),
    code: z.string().min(6).max(8),
  }),
])

/**
 * Enrolling an authenticator app when the workspace requires one and its grace period ended
 * (Phase 67). The enrollment token lives in a cookie and allows nothing else.
 */
export async function POST(request: Request) {
  const parsed = actionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ message: 'Check the code.' }, { status: 400 })
  const token = await enrollmentToken()
  if (!token) return NextResponse.json({ message: 'Sign in again.' }, { status: 401 })
  const path =
    parsed.data.action === 'start' ? '/auth/enrollment/totp' : '/auth/enrollment/totp/confirm'
  const body =
    parsed.data.action === 'start'
      ? { enrollmentToken: token }
      : { enrollmentToken: token, factorId: parsed.data.factorId, code: parsed.data.code }
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (response.ok && parsed.data.action === 'confirm') await clearEnrollment()
  return new NextResponse(await response.arrayBuffer(), {
    status: response.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
