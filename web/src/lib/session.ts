import { cookies } from 'next/headers'
import { z } from 'zod'

const apiUrl = process.env.HORIZON_API_URL ?? 'http://localhost:8000'
const issuedSessionSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.string().datetime(),
  refreshToken: z.string().min(1),
  familyId: z.uuid(),
})
const tokenClaimsSchema = z.object({ tenant_id: z.uuid() })

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.HORIZON_COOKIE_SECURE === 'true',
  path: '/',
}

export async function openSession(value: unknown): Promise<void> {
  const session = issuedSessionSchema.parse(value)
  const tenantId = tenantIdFrom(session.accessToken)
  const jar = await cookies()
  jar.set('horizon_access', session.accessToken, {
    ...cookieOptions,
    expires: new Date(session.accessTokenExpiresAt),
  })
  const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  jar.set('horizon_refresh', session.refreshToken, { ...cookieOptions, expires: refreshExpiry })
  jar.set('horizon_family', session.familyId, { ...cookieOptions, expires: refreshExpiry })
  jar.set('horizon_tenant', tenantId, { ...cookieOptions, expires: refreshExpiry })
}

export async function clearSession(): Promise<void> {
  const jar = await cookies()
  for (const name of ['horizon_access', 'horizon_refresh', 'horizon_family', 'horizon_tenant'])
    jar.delete(name)
}

export async function authenticatedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const jar = await cookies()
  const token = jar.get('horizon_access')?.value
  if (!token) return new Response(null, { status: 401 })
  let response = await upstream(path, token, init)
  if (response.status !== 401) return response
  const refreshed = await refreshSession()
  if (!refreshed) return response
  response = await upstream(path, refreshed, init)
  return response
}

export async function accessToken(): Promise<string | null> {
  return (await cookies()).get('horizon_access')?.value ?? null
}

async function refreshSession(): Promise<string | null> {
  const jar = await cookies()
  const tenantId = jar.get('horizon_tenant')?.value
  const familyId = jar.get('horizon_family')?.value
  const refreshToken = jar.get('horizon_refresh')?.value
  if (!tenantId || !familyId || !refreshToken) return null
  const response = await fetch(`${apiUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId, familyId, refreshToken }),
    cache: 'no-store',
  })
  if (!response.ok) {
    await clearSession()
    return null
  }
  const value: unknown = await response.json()
  await openSession(value)
  return issuedSessionSchema.parse(value).accessToken
}

function upstream(path: string, token: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  return fetch(`${apiUrl}${path}`, { ...init, headers, cache: 'no-store' })
}

function tenantIdFrom(token: string): string {
  const part = token.split('.')[1]
  if (!part) throw new Error('Access token has no payload')
  return tokenClaimsSchema.parse(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')))
    .tenant_id
}
