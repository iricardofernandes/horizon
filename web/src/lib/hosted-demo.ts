import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto'
import { neon } from '@neondatabase/serverless'
import { cookies } from 'next/headers'

const cookieName = 'horizon_demo_session'
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

export async function openHostedDemoSession(input: {
  tenantSlug: string
  email: string
  password: string
}): Promise<SessionUser | null> {
  const sql = database()
  const rows = (await sql`
    select id, tenant_id, email, name, password_salt, password_hash
    from horizon_demo_users
    where tenant_slug = ${input.tenantSlug} and lower(email) = lower(${input.email})
    limit 1
  `) as DemoUser[]
  const user = rows[0]
  if (!user || !passwordMatches(input.password, user.password_salt, user.password_hash)) return null

  const session = publicUser(user)
  const expires = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const token = signSession({ ...session, exp: Math.floor(expires.getTime() / 1000) })
  ;(await cookies()).set(cookieName, token, { ...cookieOptions, expires })
  return session
}

export async function hostedDemoSession(): Promise<SessionUser | null> {
  const token = (await cookies()).get(cookieName)?.value
  return token ? verifySession(token) : null
}

export async function clearHostedDemoSession(): Promise<void> {
  ;(await cookies()).delete(cookieName)
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

function signSession(payload: SessionPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', signingSecret()).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function verifySession(token: string): SessionUser | null {
  const [encoded, supplied] = token.split('.')
  if (!encoded || !supplied) return null
  const expected = createHmac('sha256', signingSecret()).update(encoded).digest()
  const actual = Buffer.from(supplied, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload
    if (
      !payload.id ||
      !payload.tenantId ||
      !payload.email ||
      !payload.name ||
      payload.exp <= Date.now() / 1000
    )
      return null
    const { exp: _, ...user } = payload
    return user
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
