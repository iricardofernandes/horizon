import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isLocale, localeCookie } from '@/i18n/locale'
import { gatewayFetch } from '@/lib/gateway'
import {
  beginHostedDemoLogin,
  clearHostedDemoSession,
  hostedDemoEnabled,
  hostedDemoSession,
} from '@/lib/hosted-demo'
import {
  accessToken,
  activeWorkspace,
  authenticatedFetch,
  clearSession,
  clearWorkspaceSelection,
  storeMfaChallenge,
  storeWorkspaceSelection,
} from '@/lib/session'

const loginSchema = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(1024),
})
const selectionSchema = z.object({
  selectionToken: z.string().min(1),
  selectionExpiresAt: z.iso.datetime(),
  workspaces: z.array(
    z.object({ tenantId: z.uuid(), slug: z.string().min(1), name: z.string().min(1) }),
  ),
})
const challengeSchema = z.object({
  mfaRequired: z.literal(true),
  challengeToken: z.string().min(1),
  challengeExpiresAt: z.iso.datetime(),
  methods: z.array(z.enum(['totp', 'recovery', 'passkey'])),
})
export async function POST(request: Request) {
  const parsed = loginSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return NextResponse.json({ message: 'Check the login fields.' }, { status: 400 })
  if (hostedDemoEnabled()) {
    await Promise.all([clearHostedDemoSession(), clearSession()])
    const workspaces = await beginHostedDemoLogin(parsed.data)
    return workspaces
      ? NextResponse.json({ workspaces })
      : NextResponse.json({ message: 'Email or password is incorrect.' }, { status: 401 })
  }
  const response = await gatewayFetch(`/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parsed.data),
    cache: 'no-store',
  })
  // Kong limits sign-ins per browser address (Phase 80): say so rather than blame the password.
  if (response.status === 429)
    return NextResponse.json(
      { message: 'Too many sign-in attempts. Try again in a minute.' },
      { status: 429, headers: { 'retry-after': response.headers.get('retry-after') ?? '60' } },
    )
  if (!response.ok)
    return NextResponse.json(
      { message: 'Email or password is incorrect.' },
      { status: response.status },
    )
  const body: unknown = await response.json()
  await clearSession()
  await clearWorkspaceSelection()
  const challenge = challengeSchema.safeParse(body)
  if (challenge.success) {
    // The password was right and the account has a second factor: it is asked next.
    await storeMfaChallenge(
      challenge.data.challengeToken,
      new Date(challenge.data.challengeExpiresAt),
    )
    return NextResponse.json({ mfaRequired: true, methods: challenge.data.methods })
  }
  const selection = selectionSchema.parse(body)
  await storeWorkspaceSelection(selection.selectionToken, new Date(selection.selectionExpiresAt))
  return NextResponse.json({ workspaces: selection.workspaces })
}

export async function GET() {
  if (hostedDemoEnabled()) {
    const user = await hostedDemoSession()
    return user
      ? NextResponse.json(
          { ...user, workspace: await activeWorkspace() },
          { headers: { 'cache-control': 'no-store' } },
        )
      : NextResponse.json({ message: 'No active session.' }, { status: 401 })
  }
  return sessionUser()
}

export async function DELETE() {
  if (hostedDemoEnabled()) {
    await Promise.all([clearHostedDemoSession(), clearSession()])
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
  await clearWorkspaceSelection()
  return new NextResponse(null, { status: 204 })
}

async function sessionUser() {
  const response = await authenticatedFetch('/identity/me')
  if (!response.ok) {
    if (response.status === 401) await clearSession()
    return NextResponse.json({ message: 'No active session.' }, { status: response.status })
  }
  const user = (await response.json()) as { preferredLocale?: unknown }
  await adoptStoredLocale(user.preferredLocale)
  return NextResponse.json(
    { ...user, workspace: await activeWorkspace() },
    { headers: { 'cache-control': 'no-store' } },
  )
}

/**
 * The account's stored choice outranks this device's cookie (ADR 0044), so a language
 * chosen on one machine is the language the next one opens in.
 */
async function adoptStoredLocale(preferred: unknown): Promise<void> {
  if (typeof preferred !== 'string' || !isLocale(preferred)) return
  const jar = await cookies()
  if (jar.get(localeCookie)?.value === preferred) return
  jar.set(localeCookie, preferred, {
    path: '/',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  })
}
