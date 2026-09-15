import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  hostedDemoEnabled,
  hostedDemoSession,
  hostedDemoWorkspaces,
  selectHostedDemoWorkspace,
} from '@/lib/hosted-demo'
import {
  activeWorkspace,
  authenticatedFetch,
  clearWorkspaceSelection,
  openSession,
  storeActiveWorkspace,
  storeWorkspaceSelection,
  workspaceSelectionToken,
} from '@/lib/session'

const apiUrl = process.env.HORIZON_API_URL ?? 'http://localhost:8000'
const selectSchema = z.strictObject({
  tenantId: z.uuid(),
  slug: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
})
const workspacesSchema = z.array(
  z.object({ tenantId: z.uuid(), slug: z.string().min(1), name: z.string().min(1) }),
)
const switchSelectionSchema = z.object({
  selectionToken: z.string().min(1),
  selectionExpiresAt: z.iso.datetime(),
  workspaces: workspacesSchema,
})

export async function GET() {
  if (hostedDemoEnabled()) {
    const workspaces = await hostedDemoWorkspaces()
    if (workspaces) return NextResponse.json({ workspaces })
    const [user, workspace] = await Promise.all([hostedDemoSession(), activeWorkspace()])
    return user && workspace
      ? NextResponse.json({ workspaces: [workspace] })
      : NextResponse.json({ message: 'Sign in again.' }, { status: 401 })
  }
  let token = await workspaceSelectionToken()
  if (!token) {
    const switchResponse = await authenticatedFetch('/auth/workspace-selection', {
      method: 'POST',
    })
    if (!switchResponse.ok)
      return NextResponse.json({ message: 'Sign in again.' }, { status: switchResponse.status })
    const selection = switchSelectionSchema.parse(await switchResponse.json())
    await storeWorkspaceSelection(selection.selectionToken, new Date(selection.selectionExpiresAt))
    token = selection.selectionToken
    return NextResponse.json({ workspaces: selection.workspaces })
  }
  const response = await fetch(`${apiUrl}/auth/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selectionToken: token }),
    cache: 'no-store',
  })
  if (!response.ok)
    return new NextResponse(await response.arrayBuffer(), {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    })
  return NextResponse.json({ workspaces: workspacesSchema.parse(await response.json()) })
}

export async function POST(request: Request) {
  const parsed = selectSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return NextResponse.json({ message: 'Choose a valid workspace.' }, { status: 400 })
  if (hostedDemoEnabled()) {
    const selected = await selectHostedDemoWorkspace(parsed.data.tenantId)
    const current = await hostedDemoSession()
    const user = selected ?? current
    if (user) await storeActiveWorkspace(parsed.data)
    return user
      ? NextResponse.json(user)
      : NextResponse.json({ message: 'Sign in again.' }, { status: 401 })
  }
  const token = await workspaceSelectionToken()
  if (!token) return NextResponse.json({ message: 'Sign in again.' }, { status: 401 })
  const response = await fetch(`${apiUrl}/auth/workspace`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selectionToken: token, tenantId: parsed.data.tenantId }),
    cache: 'no-store',
  })
  if (!response.ok)
    return new NextResponse(await response.arrayBuffer(), {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    })
  await openSession(await response.json())
  await storeActiveWorkspace(parsed.data)
  await clearWorkspaceSelection()
  const me = await authenticatedFetch('/identity/me')
  return new NextResponse(await me.arrayBuffer(), {
    status: me.status,
    headers: { 'content-type': me.headers.get('content-type') ?? 'application/json' },
  })
}
