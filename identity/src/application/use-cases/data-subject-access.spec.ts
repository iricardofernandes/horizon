import { makeApiKey } from 'test/factories/make-api-key'
import { makeRefreshTokenFamily } from 'test/factories/make-refresh-token-family'
import { identityContext } from 'test/support/identity-context'
import { describe, expect, it } from 'vitest'
import { DataSubjectKey } from '@/domain/entities/data-subject-key'
import { DisableUserUseCase } from './disable-user'
import { EraseDataSubjectUseCase } from './erase-data-subject'
import { ExportDataSubjectUseCase } from './export-data-subject'
import { RevokeSessionUseCase } from './revoke-session'

async function context() {
  const c = await identityContext()
  const subjectId = c.user.id.toString()
  const key = DataSubjectKey.issue({
    tenantId: c.tenantId,
    subjectId,
    material: 'key',
    now: c.clock.now(),
  })
  await c.scope.dataSubjectKeys.create(key)
  const family = makeRefreshTokenFamily({
    tenantId: c.tenantId,
    userId: subjectId,
    createdAt: c.clock.now(),
  })
  await c.families.create(family, 3600)
  const otherFamily = makeRefreshTokenFamily({
    tenantId: c.tenantId,
    userId: 'someone-else',
    createdAt: c.clock.now(),
  })
  await c.families.create(otherFamily, 3600)
  return {
    ...c,
    subjectId,
    key,
    family,
    otherFamily,
    request: { tenantId: c.tenantId, subjectId, userId: subjectId, actor: c.actor },
    erase: new EraseDataSubjectUseCase(c.unitOfWork, c.families, c.denylist, c.policy, c.clock),
    disable: new DisableUserUseCase(c.unitOfWork, c.families, c.denylist, c.policy, c.clock),
    exportSubject: new ExportDataSubjectUseCase(c.unitOfWork),
    logout: new RevokeSessionUseCase(c.unitOfWork, c.families, c.denylist, c.clock),
  }
}

describe('data subject access and erasure', () => {
  it('exports only this subject and keys issued in this tenant', async () => {
    const c = await context()
    const key = makeApiKey({ tenantId: c.tenantId, issuedBy: c.subjectId })
    await c.scope.apiKeys.create(key)
    await c.scope.apiKeys.create(makeApiKey({ tenantId: c.tenantId, issuedBy: 'someone-else' }))
    expect((await c.exportSubject.execute(c.request)).value).toEqual({
      user: c.user,
      apiKeys: [key],
    })
    expect(
      (await c.exportSubject.execute({ ...c.request, tenantId: 'other' })).value,
    ).toMatchObject({ name: 'ResourceNotFoundError' })
    c.user.markErased(c.clock.now())
    expect((await c.exportSubject.execute(c.request)).value).toMatchObject({
      name: 'SubjectErasedError',
    })
  })

  it('destroys the key, removes roles, emits an erasure event, and terminates all subject sessions', async () => {
    const c = await context()
    const result = await c.erase.execute({ ...c.request, requestId: 'request' })
    expect(result.isRight()).toBe(true)
    expect(c.key.material()).toBeNull()
    expect(c.key.isErased()).toBe(true)
    expect(c.user.isErased()).toBe(true)
    expect(c.user.claims().roles).toEqual([])
    expect(await c.families.findAllForUser(c.tenantId, c.subjectId)).toEqual([])
    expect(await c.families.findById(c.tenantId, c.otherFamily.id.toString())).not.toBeNull()
    expect(c.denylist.revokeSubject).toHaveBeenCalledWith(
      c.subjectId,
      new Date(c.clock.now().getTime() + 900000),
    )
    expect(c.scope.events.map((event) => event.payloadOf())).toEqual([
      expect.objectContaining({ subjectId: c.subjectId, erasedAt: c.clock.now().toISOString() }),
    ])
    expect(c.scope.auditRecords.at(-1)).toMatchObject({
      action: 'data-subject.erased',
      requestId: 'request',
    })
    expect(c.scope.userRows.has(c.subjectId)).toBe(true)
  })

  it.each(['missing-user', 'missing-key', 'already-erased-key', 'already-erased-user'])(
    'refuses erasure for %s without revoking unrelated sessions',
    async (scenario) => {
      const c = await context()
      if (scenario === 'missing-user') c.scope.userRows.clear()
      if (scenario === 'missing-key') c.scope.keyRows.clear()
      if (scenario === 'already-erased-key') c.key.destroy(c.clock.now())
      if (scenario === 'already-erased-user') c.user.markErased(c.clock.now())
      expect((await c.erase.execute(c.request)).isLeft()).toBe(true)
      expect(c.denylist.revokeSubject).not.toHaveBeenCalled()
      expect(c.scope.auditRecords).toHaveLength(0)
    },
  )
})

describe('access revocation', () => {
  it('disables the account, publishes its event, removes refresh families and denylists access tokens', async () => {
    const c = await context()
    expect((await c.disable.execute(c.request)).isRight()).toBe(true)
    expect(c.user.canAuthenticate()).toBe(false)
    expect(await c.families.findAllForUser(c.tenantId, c.subjectId)).toEqual([])
    expect(c.denylist.revokeSubject).toHaveBeenCalledWith(
      c.subjectId,
      new Date(c.clock.now().getTime() + 900000),
    )
    expect(c.scope.events[0]?.payloadOf()).toMatchObject({ userId: c.subjectId })
    expect(c.scope.auditRecords[0]).toMatchObject({
      action: 'user.disabled',
      dataSubjectId: c.subjectId,
    })
  })

  it.each(['self', 'missing', 'disabled'])(
    'refuses to disable %s and leaves sessions alone',
    async (scenario) => {
      const c = await context()
      if (scenario === 'missing') c.scope.userRows.clear()
      if (scenario === 'disabled') c.user.disable(c.clock.now())
      const actor = scenario === 'self' ? { type: 'user' as const, id: c.subjectId } : c.actor
      expect((await c.disable.execute({ ...c.request, actor })).isLeft()).toBe(true)
      expect(c.denylist.revokeSubject).not.toHaveBeenCalled()
      expect(await c.families.findAllForUser(c.tenantId, c.subjectId)).toHaveLength(1)
    },
  )

  it('logs out only an owned session and revokes its access token until its original expiry', async () => {
    const c = await context()
    const request = {
      tenantId: c.tenantId,
      userId: c.subjectId,
      familyId: c.family.id.toString(),
      jti: 'jti',
      accessTokenExpiresAt: new Date(c.clock.now().getTime() + 10000),
    }
    expect((await c.logout.execute({ ...request, tenantId: 'other' })).isLeft()).toBe(true)
    expect((await c.logout.execute({ ...request, userId: 'someone-else' })).isLeft()).toBe(true)
    expect(c.denylist.revoke).not.toHaveBeenCalled()
    expect((await c.logout.execute(request)).isRight()).toBe(true)
    expect(c.denylist.revoke).toHaveBeenCalledWith('jti', request.accessTokenExpiresAt)
    expect(await c.families.findById(c.tenantId, c.family.id.toString())).toBeNull()
    expect(c.scope.auditRecords.at(-1)).toMatchObject({
      action: 'session.revoked',
      subjectId: c.family.id.toString(),
    })
  })
})
