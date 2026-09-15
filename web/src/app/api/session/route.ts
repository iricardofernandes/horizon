import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  clearHostedDemoSession,
  hostedDemoEnabled,
  hostedDemoSession,
  openHostedDemoSession,
} from '@/lib/hosted-demo'
import { accessToken, authenticatedFetch, clearSession, openSession } from '@/lib/session'

const loginSchema = z.strictObject({
  tenantSlug: z.string().min(1).max(80),
  email: z.email().max(254),
  password: z.string().min(1).max(1024),
})
const apiUrl = process.env.HORIZON_API_URL ?? 'http://localhost:8000'

export async function POST(request: Request) {
  const parsed = loginSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return NextResponse.json({ message: 'Check the login fields.' }, { status: 400 })
  if (hostedDemoEnabled()) {
    const user = await openHostedDemoSession(parsed.data)
    return user
      ? NextResponse.json(user)
      : NextResponse.json(
          { message: 'Workspace, email or password is incorrect.' },
          { status: 401 },
        )
  }
  const response = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parsed.data),
    cache: 'no-store',
  })
  if (!response.ok)
    return NextResponse.json(
      { message: 'Workspace, email or password is incorrect.' },
      { status: response.status },
    )
  await openSession(await response.json())
  return sessionUser()
}

export async function GET() {
  if (hostedDemoEnabled()) {
    const user = await hostedDemoSession()
    return user
      ? NextResponse.json(user)
      : NextResponse.json({ message: 'No active session.' }, { status: 401 })
  }
  return sessionUser()
}

export async function DELETE() {
  if (hostedDemoEnabled()) {
    await clearHostedDemoSession()
    return new NextResponse(null, { status: 204 })
  }
  const token = await accessToken()
  if (token) {
    const familyId = (await cookies()).get('horizon_family')?.value
    const response = await authenticatedFetch('/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ familyId }),
    })
    await response.body?.cancel().catch(() => undefined)
  }
  await clearSession()
  return new NextResponse(null, { status: 204 })
}

async function sessionUser() {
  const response = await authenticatedFetch('/identity/me')
  if (!response.ok) {
    if (response.status === 401) await clearSession()
    return NextResponse.json({ message: 'No active session.' }, { status: response.status })
  }
  return NextResponse.json(await response.json())
}
