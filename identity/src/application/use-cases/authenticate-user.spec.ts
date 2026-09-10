import { identityContext, valid } from 'test/support/identity-context'
import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import { PasswordHash } from '@/domain/value-objects/password-hash'
import { AuthenticateUserUseCase } from './authenticate-user'

async function context() {
  const c = await identityContext()
  return {
    ...c,
    sut: new AuthenticateUserUseCase(
      c.unitOfWork,
      c.unitOfWork.directory,
      c.hasher,
      c.sessions,
      c.policy,
      c.clock,
    ),
    request: { tenantSlug: ' EXAMPLE ', email: ' Person@Example.com ', password: 'correct' },
  }
}

describe('AuthenticateUserUseCase', () => {
  it('opens a session, records the login, and audits request metadata', async () => {
    const c = await context()
    const result = await c.sut.execute({
      ...c.request,
      sourceIp: '192.0.2.1',
      requestId: 'request',
    })
    expect(result.isRight()).toBe(true)
    expect(snapshotOf(c.user).lastLoginAt).toEqual(c.clock.now())
    expect(await c.families.findAllForUser(c.tenantId, c.user.id.toString())).toHaveLength(1)
    expect(c.scope.auditRecords).toEqual([
      expect.objectContaining({
        action: 'session.opened',
        sourceIp: '192.0.2.1',
        requestId: 'request',
      }),
    ])
    expect(c.hasher.hash).not.toHaveBeenCalled()
  })

  it.each([{ email: 'invalid' }, { tenantSlug: 'unknown' }, { email: 'unknown@example.com' }])(
    'uses dummy verification and indistinguishable rejection for %j',
    async (patch) => {
      const c = await context()
      const result = await c.sut.execute({ ...c.request, ...patch })
      expect(result.value).toMatchObject({ name: 'InvalidCredentialsError' })
      expect(c.hasher.verifyDummy).toHaveBeenCalledOnce()
      expect(c.signer.mint).not.toHaveBeenCalled()
    },
  )

  it('handles a missing tenant row and a suspended tenant without issuing a session', async () => {
    const c = await context()
    c.tenant.suspend(c.clock.now())
    expect((await c.sut.execute(c.request)).value).toMatchObject({ name: 'TenantSuspendedError' })
    c.scope.tenantRows.clear()
    expect((await c.sut.execute(c.request)).value).toMatchObject({
      name: 'InvalidCredentialsError',
    })
    expect(c.hasher.verifyDummy).toHaveBeenCalledTimes(2)
    expect(c.signer.mint).not.toHaveBeenCalled()
  })

  it('verifies passwords before revealing a disabled account and audits wrong passwords', async () => {
    const c = await context()
    c.user.disable(c.clock.now())
    expect((await c.sut.execute({ ...c.request, password: 'incorrect' })).value).toMatchObject({
      name: 'InvalidCredentialsError',
    })
    expect((await c.sut.execute(c.request)).value).toMatchObject({ name: 'AccountDisabledError' })
    expect(c.hasher.verify).toHaveBeenCalledTimes(2)
    expect(c.scope.auditRecords).toEqual([
      expect.objectContaining({ action: 'session.rejected', sourceIp: null, requestId: null }),
    ])
    expect(c.signer.mint).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'upgrades weak hashes and tolerates an unusable upgrade result (%s)',
    async (malformed) => {
      const c = await context()
      c.user.changePassword(
        valid(PasswordHash.create('$argon2id$v=19$m=1024,t=1,p=1$c2FsdA$aGFzaA')),
        c.clock.now(),
      )
      if (malformed) c.hasher.hash.mockResolvedValue('broken')
      const result = await c.sut.execute(c.request)
      expect(result.isRight()).toBe(true)
      expect(c.hasher.hash).toHaveBeenCalledWith('correct')
      expect(c.user.needsRehash(c.policy.argon2())).toBe(malformed)
    },
  )
})
