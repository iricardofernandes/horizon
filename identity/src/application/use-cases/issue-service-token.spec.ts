import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { AccessTokenSigner } from '../ports/access-token-signer'
import type { UnitOfWork } from '../ports/unit-of-work'
import { IssueServiceTokenUseCase, SERVICE_GRANTS, serviceClientsOf } from './issue-service-token'

const secret = 'a-service-secret-that-is-long-enough-for-this'
const tenantId = randomUUID()
const now = new Date('2026-09-28T02:00:00.000Z')

function world(tenantExists = true) {
  const audit: unknown[] = []
  const unitOfWork = {
    inTenant: async (_tenant: string, work: (scope: unknown) => Promise<unknown>) =>
      work({
        tenants: { findById: async () => (tenantExists ? { id: tenantId } : null) },
        audit: { append: async (record: unknown) => audit.push(record) },
      }),
  } as unknown as UnitOfWork
  const signer = {
    mint: vi.fn(async () => ({
      token: 'signed',
      jti: 'jti-1',
      kid: 'dev-1',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 900_000),
    })),
  } as unknown as AccessTokenSigner
  const clients = serviceClientsOf(
    `reporting:${createHash('sha256').update(secret).digest('hex')},broken:xyz`,
  )
  return {
    audit,
    signer,
    use: new IssueServiceTokenUseCase(unitOfWork, signer, clients, { now: () => now }),
  }
}

describe('service tokens (Phase 69)', () => {
  it('reads only well-formed client entries', () => {
    expect([...serviceClientsOf('reporting:abc, x:').keys()]).toEqual([])
    expect(world().use).toBeDefined()
  })

  it('issues a read-only token for a known client and tenant, and audits it', async () => {
    const { use, signer, audit } = world()
    const issued = await use.execute({ client: 'reporting', secret, tenantId })
    expect(issued.isRight() && issued.value.accessToken).toBe('signed')
    expect(signer.mint).toHaveBeenCalledWith(
      { subject: 'service:reporting', tenantId, roles: SERVICE_GRANTS.reporting },
      now,
    )
    expect(audit).toMatchObject([
      { action: 'service-token.issued', subjectId: 'reporting', actor: { type: 'system' } },
    ])
    const roles = SERVICE_GRANTS.reporting ?? []
    expect(roles.every((role) => ['viewer', 'auditor'].includes(role.role))).toBe(true)
  })

  it('refuses a wrong secret, an unknown client and an unknown tenant alike', async () => {
    expect(
      (await world().use.execute({ client: 'reporting', secret: `${secret}x`, tenantId })).isLeft(),
    ).toBe(true)
    expect((await world().use.execute({ client: 'fiscal', secret, tenantId })).isLeft()).toBe(true)
    expect(
      (await world(false).use.execute({ client: 'reporting', secret, tenantId })).isLeft(),
    ).toBe(true)
  })
})
