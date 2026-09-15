import { scryptSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cookieValues = new Map<string, string>()
const setCookie = vi.fn((name: string, value: string) => cookieValues.set(name, value))
const deleteCookie = vi.fn((name: string) => cookieValues.delete(name))
const query = vi.fn(async (parts: TemplateStringsArray) => {
  const statement = parts.join('?')
  if (statement.includes('from horizon_demo_users')) {
    const salt = '00112233445566778899aabbccddeeff'
    return [
      {
        id: '00000000-0000-4000-8000-000000000002',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        tenant_slug: 'horizon-demo',
        tenant_name: 'Horizon Demo',
        email: 'demo@horizon.local',
        name: 'Demo Operator',
        password_salt: salt,
        password_hash: scryptSync('Horizon-demo-2026!', Buffer.from(salt, 'hex'), 32).toString(
          'hex',
        ),
      },
    ]
  }
  if (statement.includes('from horizon_demo_catalog_items')) {
    return [
      {
        id: '00000000-0000-4000-8000-000000000011',
        sku: 'COFFEE-001',
        name: 'Roasted coffee',
        kind: 'product',
        active: true,
      },
    ]
  }
  if (statement.includes('from horizon_demo_catalog_prices')) {
    return [{ itemId: '00000000-0000-4000-8000-000000000011', amount: '1250' }]
  }
  return []
})

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieValues.get(name)
      return value ? { value } : undefined
    },
    set: setCookie,
    delete: deleteCookie,
  }),
}))

vi.mock('@neondatabase/serverless', () => ({ neon: () => query }))

import {
  beginHostedDemoLogin,
  clearHostedDemoSession,
  hostedDemoEnabled,
  hostedDemoResponse,
  hostedDemoSession,
  hostedDemoWorkspaces,
  selectHostedDemoWorkspace,
} from './hosted-demo'

function firstTenantId(
  workspaces: Array<{ tenantId: string; slug: string; name: string }> | null,
): string {
  const tenantId = workspaces?.[0]?.tenantId
  if (!tenantId) throw new Error('Expected a selectable demo workspace')
  return tenantId
}

describe('hosted demo', () => {
  beforeEach(() => {
    cookieValues.clear()
    query.mockClear()
    setCookie.mockClear()
    deleteCookie.mockClear()
    process.env.DATABASE_URL = 'postgresql://demo.invalid/horizon'
    process.env.HORIZON_SESSION_SECRET = 'test-session-secret-with-more-than-32-characters'
    process.env.HORIZON_HOSTED_DEMO = 'true'
  })

  it('authenticates first and opens a session only after workspace selection', async () => {
    expect(hostedDemoEnabled()).toBe(true)
    const workspaces = await beginHostedDemoLogin({
      email: 'demo@horizon.local',
      password: 'Horizon-demo-2026!',
    })

    expect(workspaces).toEqual([
      {
        tenantId: '00000000-0000-4000-8000-000000000001',
        slug: 'horizon-demo',
        name: 'Horizon Demo',
      },
    ])
    expect(await hostedDemoSession()).toBeNull()
    expect(await hostedDemoWorkspaces()).toEqual(workspaces)
    const user = await selectHostedDemoWorkspace(firstTenantId(workspaces))
    expect(user).toMatchObject({ name: 'Demo Operator', roles: [{ role: 'viewer' }] })
    expect(setCookie).toHaveBeenCalledWith(
      'horizon_demo_session',
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    )
    expect(await hostedDemoSession()).toEqual(user)
  })

  it('rejects an incorrect password and a modified cookie', async () => {
    expect(
      await beginHostedDemoLogin({
        email: 'demo@horizon.local',
        password: 'incorrect',
      }),
    ).toBeNull()

    const workspaces = await beginHostedDemoLogin({
      email: 'demo@horizon.local',
      password: 'Horizon-demo-2026!',
    })
    await selectHostedDemoWorkspace(firstTenantId(workspaces))
    const token = cookieValues.get('horizon_demo_session')
    expect(token).toBeDefined()
    cookieValues.set('horizon_demo_session', `${token}tampered`)
    expect(await hostedDemoSession()).toBeNull()
  })

  it('serves only the authenticated Catalog surface', async () => {
    expect((await hostedDemoResponse('/catalog/items')).status).toBe(401)
    const workspaces = await beginHostedDemoLogin({
      email: 'demo@horizon.local',
      password: 'Horizon-demo-2026!',
    })
    await selectHostedDemoWorkspace(firstTenantId(workspaces))

    const items = await hostedDemoResponse('/catalog/items?limit=100')
    expect(items.status).toBe(200)
    expect(await items.json()).toEqual({
      data: [expect.objectContaining({ sku: 'COFFEE-001', name: 'Roasted coffee' })],
    })
    expect((await hostedDemoResponse('/sales/orders')).status).toBe(501)
  })

  it('clears the hosted session', async () => {
    await clearHostedDemoSession()
    expect(deleteCookie).toHaveBeenCalledWith('horizon_demo_session')
    expect(deleteCookie).toHaveBeenCalledWith('horizon_demo_workspace_selection')
  })
})
