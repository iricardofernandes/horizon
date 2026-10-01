import { randomUUID } from 'node:crypto'
import { SEGREGATION_OF_DUTIES_TYPE } from '@horizon/contracts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createFiscalServer } from './api'
import type { FiscalPrincipal } from './auth'
import { RuleChangeDutiesRefused, RuleChangeRefused } from './rule-changes'

const tenantId = randomUUID()
const changeId = randomUUID()
let role: FiscalPrincipal['role'] = 'admin'
const decide = vi.fn()
const request = vi.fn()
const grant = vi.fn()

const server = createFiscalServer({
  verifier: { verify: async () => ({ tenantId, subject: 'admin:ana', role }) },
  governance: {
    changes: {
      packages: async () => [],
      workspaceRules: async () => [],
      diffPackage: async () => {
        throw new RuleChangeRefused(404, 'Catalogue package not found')
      },
      request,
      decide,
      cancel: vi.fn(),
      get: async () => null,
      list: async () => ({ data: [] }),
    },
    delegations: { list: async () => [], grant, revoke: vi.fn() },
  },
} as never)
let base = ''

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('the rule governance routes (Phase 88)', () => {
  it('refuses a decision by the requester with the one segregation-of-duties answer', async () => {
    role = 'admin'
    decide.mockRejectedValueOnce(
      new RuleChangeDutiesRefused('Whoever asked for a rule change cannot decide it'),
    )
    const response = await post(`/rule-changes/${changeId}/approve`)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      type: SEGREGATION_OF_DUTIES_TYPE,
      code: 'segregation-of-duties',
      pair: 'fiscal.rules',
    })
  })

  it('lets only an admin request, and passes whether the decider holds the approval by role', async () => {
    role = 'issuer'
    expect((await post('/rule-changes', { kind: 'retire-rule' })).status).toBe(403)
    expect(request).not.toHaveBeenCalled()
    decide.mockResolvedValueOnce({ id: changeId })
    expect((await post(`/rule-changes/${changeId}/reject`, { reason: 'Not now' })).status).toBe(200)
    expect(decide).toHaveBeenLastCalledWith(
      expect.objectContaining({ holdsApproval: false, outcome: 'rejected', reason: 'Not now' }),
    )
    role = 'admin'
    decide.mockResolvedValueOnce({ id: changeId })
    await post(`/rule-changes/${changeId}/approve`)
    expect(decide).toHaveBeenLastCalledWith(expect.objectContaining({ holdsApproval: true }))
  })

  it('answers a refusal with its status, and an unknown package with 404', async () => {
    role = 'admin'
    request.mockRejectedValueOnce(
      new RuleChangeRefused(409, 'A pending request is already about this', {
        pendingChangeId: changeId,
      }),
    )
    const conflict = await post('/rule-changes', { kind: 'retire-rule' })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ pendingChangeId: changeId })
    const diff = await fetch(`${base}/catalog/packages/${randomUUID()}/diff`, {
      headers: { authorization: 'Bearer test' },
    })
    expect(diff.status).toBe(404)
  })
})
