import { expect, it } from 'vitest'
import { right } from '@/core/either'
import type { IdentityRuntime } from '@/main/identity-runtime'
import { AuthController } from './auth.controller'

const tenantId = '00000000-0000-4000-8000-000000000001'
const scopes = ['parties:read', 'identity:read', 'catalog:read']
const roles = [
  { module: 'identity', role: 'owner' },
  { module: 'identity', role: 'fiscal-reader' },
  { module: 'parties', role: 'fiscal-reader' },
  { module: 'catalog', role: 'viewer' },
]

function controller(grants: { scopes: string[]; roles: typeof roles }) {
  let claims: unknown
  const runtime = {
    authenticateApiKey: {
      execute: async () => right({ apiKeyId: 'key-1', issuedBy: 'user-1', ...grants }),
    },
    signer: {
      mint: async (value: unknown) => {
        claims = value
        return { token: 'signed-token', expiresAt: new Date('2026-09-21T12:15:00Z') }
      },
    },
  } as unknown as IdentityRuntime
  return { controller: new AuthController(runtime), mintedClaims: () => claims }
}

it('exchanges a scoped service key for a short fiscal token without broad issuer roles', async () => {
  const subject = controller({ scopes, roles })
  await expect(
    subject.controller.fiscalToken({ tenantId, presented: 'service-key' }),
  ).resolves.toEqual({
    tenantId,
    accessToken: 'signed-token',
    expiresAt: '2026-09-21T12:15:00.000Z',
  })
  expect(subject.mintedClaims()).toEqual({
    subject: 'api-key:key-1',
    tenantId,
    roles: [
      { module: 'parties', role: 'fiscal-reader' },
      { module: 'identity', role: 'fiscal-reader' },
      { module: 'catalog', role: 'viewer' },
    ],
  })
})

it('rejects keys missing one scope or dedicated role', async () => {
  const missingScope = controller({ scopes: ['parties:read', 'identity:read'], roles })
  await expect(
    missingScope.controller.fiscalToken({ tenantId, presented: 'service-key' }),
  ).rejects.toThrow('lacks required access')
  const missingRole = controller({
    scopes,
    roles: roles.filter((role) => role.module !== 'parties'),
  })
  await expect(
    missingRole.controller.fiscalToken({ tenantId, presented: 'service-key' }),
  ).rejects.toThrow('lacks required access')
  const missingCatalogViewer = controller({
    scopes,
    roles: roles.map((role) =>
      role.module === 'catalog' ? { module: 'catalog', role: 'owner' } : role,
    ),
  })
  await expect(
    missingCatalogViewer.controller.fiscalToken({ tenantId, presented: 'service-key' }),
  ).rejects.toThrow('lacks required access')
})
