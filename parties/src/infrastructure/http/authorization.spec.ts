import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { describe, expect, it } from 'vitest'
import type { AccessClaims } from '@/infrastructure/cryptography/access-token-verifier'
import type { PartiesRuntime } from '@/main/parties-runtime'
import { PartiesAuthGuard, type PartiesRequest, RequirePartiesAction } from './authorization'

const handler = () => undefined
RequirePartiesAction('fiscal-read')(handler)

function authorize(roles: AccessClaims['roles']): Promise<boolean> {
  const request: PartiesRequest = { headers: { authorization: 'Bearer test-token' } }
  const principal: AccessClaims = {
    subject: 'service',
    tenantId: '00000000-0000-4000-8000-000000000001',
    roles,
  }
  const runtime = {
    accessTokens: { verify: async () => principal },
  } as unknown as PartiesRuntime
  const context = {
    getHandler: () => handler,
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
