import { SCOPE_REFUSAL_MESSAGE } from '@horizon/contracts'
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { describe, expect, it } from 'vitest'
import type { AccessClaims } from '@/infrastructure/cryptography/access-token-verifier'
import type { PartiesRuntime } from '@/main/parties-runtime'
import { PartiesAuthGuard, type PartiesRequest, RequirePartiesAction } from './authorization'

const handler = () => undefined
RequirePartiesAction('fiscal-read')(handler)
const importHandler = () => undefined
RequirePartiesAction('import')(importHandler)

function authorize(
  roles: AccessClaims['roles'],
  target = handler,
  key?: { readonly scopes: readonly string[]; readonly method: string },
): Promise<boolean> {
  const request = {
    headers: { authorization: 'Bearer test-token' },
    ...(key ? { method: key.method } : {}),
  } as PartiesRequest
  const principal: AccessClaims = {
    subject: 'service',
    tenantId: '00000000-0000-4000-8000-000000000001',
    roles,
    ...(key ? { scopes: key.scopes } : {}),
  }
  const runtime = {
    accessTokens: { verify: async () => principal },
  } as unknown as PartiesRuntime
  const context = {
    getHandler: () => target,
    getClass: () => class FiscalExports {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext
  return new PartiesAuthGuard(runtime, new Reflector()).canActivate(context)
}

describe('restricted recipient fiscal exports', () => {
  it('allows the dedicated reader role', async () => {
    await expect(authorize([{ module: 'parties', role: 'fiscal-reader' }])).resolves.toBe(true)
  })

  it('rejects ordinary readers, admins and legacy Sales roles', async () => {
    for (const roles of [
      [{ module: 'parties', role: 'viewer' }],
      [{ module: 'parties', role: 'admin' }],
      [{ module: 'sales', role: 'admin' }],
    ]) {
      await expect(authorize(roles)).rejects.toThrow('does not permit')
    }
  })
})

describe('bulk imports', () => {
  it("are an administrator's work only", async () => {
    await expect(authorize([{ module: 'parties', role: 'admin' }], importHandler)).resolves.toBe(
      true,
    )
    for (const roles of [
      [{ module: 'parties', role: 'editor' }],
      [{ module: 'sales', role: 'admin' }],
      [{ module: 'catalog', role: 'admin' }],
    ])
      await expect(authorize(roles, importHandler)).rejects.toThrow('does not permit')
  })
})

describe('an API key token (ADR 0064)', () => {
  const reader = [{ module: 'parties', role: 'fiscal-reader' }]

  it('reads with a parties scope', async () => {
    await expect(
      authorize(reader, handler, { scopes: ['parties:read'], method: 'GET' }),
    ).resolves.toBe(true)
  })

  it('refuses a write with a read scope, and a read without a parties scope', async () => {
    const admin = [{ module: 'parties', role: 'admin' }]
    await expect(
      authorize(admin, importHandler, { scopes: ['parties:read'], method: 'POST' }),
    ).rejects.toThrow(SCOPE_REFUSAL_MESSAGE)
    await expect(
      authorize(reader, handler, { scopes: ['catalog:read'], method: 'GET' }),
    ).rejects.toThrow(SCOPE_REFUSAL_MESSAGE)
  })
})
