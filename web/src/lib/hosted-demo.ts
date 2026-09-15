import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto'
import { neon } from '@neondatabase/serverless'
import { cookies } from 'next/headers'

const cookieName = 'horizon_demo_session'
const selectionCookieName = 'horizon_demo_workspace_selection'
const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
}

type DemoUser = {
  id: string
  tenant_id: string
  email: string
  name: string
  tenant_slug: string
  tenant_name: string
  password_salt: string
  password_hash: string
}

type SessionUser = {
  id: string
  tenantId: string
  email: string
  name: string
  roles: Array<{ module: string; role: string }>
}

type SessionPayload = SessionUser & { exp: number }

export function hostedDemoEnabled(): boolean {
  return process.env.HORIZON_HOSTED_DEMO === 'true'
}

export async function beginHostedDemoLogin(input: {
  email: string
  password: string
}): Promise<Array<{ tenantId: string; slug: string; name: string }> | null> {
  const sql = database()
  const rows = (await sql`
    select id, tenant_id, tenant_slug, tenant_name, email, name, password_salt, password_hash
    from horizon_demo_users
    where lower(email) = lower(${input.email})
    limit 1
  `) as DemoUser[]
  const user = rows[0]
  if (!user || !passwordMatches(input.password, user.password_salt, user.password_hash)) return null

  const expires = new Date(Date.now() + 5 * 60 * 1000)
  const selection = {
    user: publicUser(user),
    workspace: { tenantId: user.tenant_id, slug: user.tenant_slug, name: user.tenant_name },
    exp: Math.floor(expires.getTime() / 1000),
  }
  ;(await cookies()).set(selectionCookieName, signPayload(selection), {
    ...cookieOptions,
    expires,
  })
  return [selection.workspace]
}

export async function hostedDemoWorkspaces() {
  const selection = await hostedSelection()
  return selection ? [selection.workspace] : null
}

export async function selectHostedDemoWorkspace(tenantId: string): Promise<SessionUser | null> {
  const selection = await hostedSelection()
  if (!selection || selection.workspace.tenantId !== tenantId) return null
  const expires = new Date(Date.now() + 8 * 60 * 60 * 1000)
  ;(await cookies()).set(
    cookieName,
    signPayload({ ...selection.user, exp: Math.floor(expires.getTime() / 1000) }),
    { ...cookieOptions, expires },
  )
  ;(await cookies()).delete(selectionCookieName)
  return selection.user
}

export async function hostedDemoSession(): Promise<SessionUser | null> {
  const token = (await cookies()).get(cookieName)?.value
  return token ? verifySession(token) : null
}

export async function clearHostedDemoSession(): Promise<void> {
  const jar = await cookies()
  jar.delete(cookieName)
  jar.delete(selectionCookieName)
}

export async function hostedDemoResponse(path: string): Promise<Response> {
  const user = await hostedDemoSession()
  if (!user) return Response.json({ message: 'No active session.' }, { status: 401 })
  const url = new URL(path, 'https://horizon.invalid')
  const sql = database()

  if (url.pathname === '/catalog/items') {
    const rows = await sql`
      select id, sku, name, kind, active, created_at as "createdAt", updated_at as "updatedAt"
      from horizon_demo_catalog_items
      where tenant_id = ${user.tenantId}
      order by name
    `
    return Response.json({ data: rows })
  }

  if (url.pathname === '/catalog/price-lists') {
    const prices = await sql`
      select item_id as "itemId", amount::text as amount
      from horizon_demo_catalog_prices
      where tenant_id = ${user.tenantId}
      order by item_id
    `
    return Response.json({
      data: [
        {
          id: '00000000-0000-4000-8000-000000000101',
          name: 'Public demo',
          currency: 'BRL',
          prices,
          active: true,
        },
      ],
    })
  }

  return Response.json(
    { message: 'This bounded context is not part of the minimal public deployment.' },
    { status: 501 },
  )
}

function database() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required for the hosted demo')
  return neon(url)
}

function passwordMatches(password: string, salt: string, expected: string): boolean {
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), 32)
  const stored = Buffer.from(expected, 'hex')
  return actual.length === stored.length && timingSafeEqual(actual, stored)
}

function publicUser(user: DemoUser): SessionUser {
  return {
    id: user.id,
    tenantId: user.tenant_id,
    email: user.email,
    name: user.name,
    roles: [{ module: 'catalog', role: 'viewer' }],
  }
}

function signPayload(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', signingSecret()).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function verifySession(token: string): SessionUser | null {
  const payload = verifyPayload(token) as SessionPayload | null
  if (!payload?.id || !payload.tenantId || !payload.email || !payload.name) return null
  const { exp: _, ...user } = payload
  return user
}

async function hostedSelection(): Promise<{
  user: SessionUser
  workspace: { tenantId: string; slug: string; name: string }
} | null> {
  const token = (await cookies()).get(selectionCookieName)?.value
  if (!token) return null
  const payload = verifyPayload(token) as {
    user?: SessionUser
    workspace?: { tenantId?: string; slug?: string; name?: string }
    exp?: number
  } | null
  if (
    !payload?.user?.id ||
    !payload.user.tenantId ||
    !payload.workspace?.tenantId ||
    !payload.workspace.slug ||
    !payload.workspace.name
  )
    return null
  return {
    user: payload.user,
    workspace: {
      tenantId: payload.workspace.tenantId,
      slug: payload.workspace.slug,
      name: payload.workspace.name,
    },
  }
}

function verifyPayload(token: string): ({ exp: number } & Record<string, unknown>) | null {
  const [encoded, supplied] = token.split('.')
  if (!encoded || !supplied) return null
  const expected = createHmac('sha256', signingSecret()).update(encoded).digest()
  const actual = Buffer.from(supplied, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      exp?: number
    } & Record<string, unknown>
    if (typeof payload.exp !== 'number' || payload.exp <= Date.now() / 1000) return null
    return payload as { exp: number } & Record<string, unknown>
  } catch {
    return null
  }
}

function signingSecret(): string {
  const secret = process.env.HORIZON_SESSION_SECRET
  if (!secret || secret.length < 32)
    throw new Error('HORIZON_SESSION_SECRET must contain at least 32 characters')
  return secret
}
