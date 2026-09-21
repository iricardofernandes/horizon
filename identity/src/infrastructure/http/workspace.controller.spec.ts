import { expect, it } from 'vitest'
import { right } from '@/core/either'
import type { IdentityRuntime } from '@/main/identity-runtime'
import type { IdentityHttpRequest } from './http-context'
import { WorkspaceController } from './workspace.controller'

const tenantId = '00000000-0000-4000-8000-000000000001'

function request(role: string): IdentityHttpRequest {
  return {
    method: 'GET',
    url: '/workspace/company/fiscal-profiles',
    headers: {},
    principal: {
      subject: 'reader',
      tenantId,
      roles: [{ module: 'identity', role }],
      jti: 'test',
      expiresAt: new Date('2026-09-22T00:00:00Z'),
    },
  }
}

it('requires the dedicated issuer reader role for exact exports and revision discovery', async () => {
  const runtime = {
    database: { findCompanyFiscalExport: async () => ({ tenantId, revision: 1 }) },
    readWorkspace: {
      execute: async () => right({ tenant: { toSnapshot: () => ({ fiscalProfileRevision: 1 }) } }),
    },
  } as unknown as IdentityRuntime
  const controller = new WorkspaceController(runtime)
  await expect(controller.fiscalProfile('1', request('member'))).rejects.toThrow('reader role')
  await expect(controller.fiscalProfileRevisions(request('owner'))).rejects.toThrow('reader role')
  await expect(controller.fiscalProfile('1', request('fiscal-reader'))).resolves.toEqual({
    tenantId,
    revision: 1,
  })
  await expect(controller.fiscalProfileRevisions(request('fiscal-reader'))).resolves.toEqual({
    tenantId,
    data: [{ revision: 1 }],
  })
})
