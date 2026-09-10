import { makeApiKey } from 'test/factories/make-api-key'
import { identityContext } from 'test/support/identity-context'
import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import { AuthenticateApiKeyUseCase } from './authenticate-api-key'
import { CreateApiKeyUseCase } from './create-api-key'
import { ListApiKeysUseCase } from './list-api-keys'
import { RevokeApiKeyUseCase } from './revoke-api-key'
import { RotateApiKeyUseCase } from './rotate-api-key'

async function context() {
  const c = await identityContext()
  const key = makeApiKey({ tenantId: c.tenantId, issuedBy: c.user.id.toString() })
  await c.scope.apiKeys.create(key)
  const presented = `hz_test_${'A'.repeat(24)}_${'B'.repeat(32)}`
  c.hasher.verify.mockResolvedValue(true)
  return {
    ...c,
    key,
    presented,
    create: new CreateApiKeyUseCase(c.unitOfWork, c.hasher, c.secrets, c.policy, c.clock),
    authenticate: new AuthenticateApiKeyUseCase(c.unitOfWork, c.hasher, c.clock),
    rotate: new RotateApiKeyUseCase(c.unitOfWork, c.hasher, c.secrets, c.policy, c.clock),
    revoke: new RevokeApiKeyUseCase(c.unitOfWork, c.clock),
    createRequest: {
      tenantId: c.tenantId,
      issuedBy: c.user.id.toString(),
      name: 'New Integration',
      scopes: ['identity:read'],
      actor: c.actor,
    },
    rotateRequest: {
      tenantId: c.tenantId,
      apiKeyId: key.id.toString(),
      overlapSeconds: 30,
      actor: c.actor,
    },
  }
}

describe('API key issuance and revocation', () => {
  it('returns a credential once and persists only its prefix and hash, scoped to its issuer', async () => {
    const c = await context()
    const expiresAt = new Date(c.clock.now().getTime() + 60000)
    const result = await c.create.execute({ ...c.createRequest, expiresAt, requestId: 'request' })
    if (result.isLeft()) throw result.value
    expect(result.value.token).toMatch(/^hz_test_[A-Za-z0-9]{24}_[A-Za-z0-9]{32}$/)
    const stored = c.scope.apiKeyRows.get(result.value.apiKeyId)
    expect(stored ? snapshotOf(stored) : undefined).toMatchObject({
      prefix: result.value.prefix,
      secretHash: expect.stringContaining('$argon2id$'),
      expiresAt,
    })
    expect(JSON.stringify(stored ? snapshotOf(stored) : undefined)).not.toContain(
      result.value.token,
    )
    expect(c.scope.auditRecords.at(-1)).toMatchObject({
      action: 'api-key.created',
      requestId: 'request',
      after: { issuedBy: c.user.id.toString(), scopes: ['identity:read'] },
    })
    expect((await c.create.execute(c.createRequest)).isRight()).toBe(true)
  })

  it('refuses invalid scopes, absent users, excessive grants, and disabled issuers', async () => {
    const c = await context()
    expect((await c.create.execute({ ...c.createRequest, scopes: [] })).isLeft()).toBe(true)
    expect(
      (await c.create.execute({ ...c.createRequest, issuedBy: 'missing' })).value,
    ).toMatchObject({ name: 'ResourceNotFoundError' })
    expect(
      (await c.create.execute({ ...c.createRequest, scopes: ['catalog:write'] })).value,
    ).toMatchObject({ name: 'ScopeBeyondIssuerError', modules: ['catalog'] })
    c.user.disable(c.clock.now())
    expect((await c.create.execute(c.createRequest)).isLeft()).toBe(true)
    expect(c.scope.apiKeyRows.size).toBe(1)
  })

  it('revokes immediately with one event, refuses repeats and cannot revoke across tenants', async () => {
    const c = await context()
    const request = { tenantId: c.tenantId, apiKeyId: c.key.id.toString(), actor: c.actor }
    expect((await c.revoke.execute({ ...request, tenantId: 'other' })).isLeft()).toBe(true)
    expect(c.key.isUsableAt(c.clock.now())).toBe(true)
    expect((await c.revoke.execute(request)).isRight()).toBe(true)
    expect(c.key.isUsableAt(c.clock.now())).toBe(false)
    expect((await c.revoke.execute(request)).isLeft()).toBe(true)
    expect(c.scope.events.map((event) => event.payloadOf())).toEqual([
      expect.objectContaining({ apiKeyId: c.key.id.toString(), prefix: 'A'.repeat(24) }),
    ])
    expect(c.scope.auditRecords).toHaveLength(1)
  })

  it('lists key metadata using bounded tenant-specific pagination', async () => {
    const c = await context()
    await c.create.execute(c.createRequest)
    const sut = new ListApiKeysUseCase(c.unitOfWork)
    const first = await sut.execute({ tenantId: c.tenantId, limit: 1 })
    expect(first.value.items).toEqual([c.key])
    expect(first.value.hasMore).toBe(true)
    const second = await sut.execute({ tenantId: c.tenantId, cursor: c.key.id.toString() })
    expect(second.value.items).toHaveLength(1)
    expect(second.value.hasMore).toBe(false)
    expect((await sut.execute({ tenantId: 'other' })).value.items).toEqual([])
  })
})

describe('API key authentication', () => {
  it('returns current issuer roles and throttles last-used writes to one minute', async () => {
    const c = await context()
    const request = { tenantId: c.tenantId, presented: c.presented }
    const result = await c.authenticate.execute(request)
    expect(result.value).toMatchObject({
      apiKeyId: c.key.id.toString(),
      roles: c.user.claims().roles,
      scopes: ['identity:read'],
    })
    const writes = c.scope.writes.length
    c.advance(59999)
    expect((await c.authenticate.execute(request)).isRight()).toBe(true)
    expect(c.scope.writes).toHaveLength(writes)
    c.advance(1)
    await c.authenticate.execute(request)
    expect(c.scope.writes).toHaveLength(writes + 1)
  })

  it.each([
    'malformed',
    'unknown',
    'wrong-environment',
    'revoked',
    'expired',
    'wrong-secret',
    'missing-issuer',
    'disabled',
  ])('refuses %s credentials', async (scenario) => {
    const c = await context()
    let presented = c.presented
    let tenantId = c.tenantId
    switch (scenario) {
      case 'malformed':
        presented = 'broken'
        break
      case 'unknown':
        tenantId = 'other'
        break
      case 'wrong-environment':
        presented = presented.replace('hz_test_', 'hz_live_')
        break
      case 'revoked':
        c.key.revoke(c.clock.now())
        break
      case 'expired':
        await c.scope.apiKeys.create(
          makeApiKey({
            tenantId,
            issuedBy: c.user.id.toString(),
            expiresAt: c.clock.now(),
            prefix: 'C'.repeat(24),
          }),
        )
        presented = presented.replace('A'.repeat(24), 'C'.repeat(24))
        break
      case 'wrong-secret':
        c.hasher.verify.mockResolvedValue(false)
        break
      case 'missing-issuer':
        c.scope.userRows.clear()
        break
      case 'disabled':
        c.user.disable(c.clock.now())
        break
    }
    const result = await c.authenticate.execute({ tenantId, presented })
    expect(result.value).toMatchObject({ name: 'InvalidCredentialsError' })
  })

  it('rechecks scopes when an issuer loses a role, retaining audit evidence of the refusal', async () => {
    const c = await context()
    c.user.revokeRole({ module: 'identity', role: 'owner' }, c.clock.now())
    const result = await c.authenticate.execute({ tenantId: c.tenantId, presented: c.presented })
    expect(result.value).toMatchObject({ name: 'ScopeBeyondIssuerError', modules: ['identity'] })
    expect(c.scope.auditRecords).toEqual([
      expect.objectContaining({
        action: 'api-key.exceeds-issuer',
        after: { modulesBeyondIssuer: ['identity'] },
      }),
    ])
  })
})

describe('API key rotation', () => {
  it.each([0, 30])(
    'honors a %s-second overlap exactly and preserves issuer/scopes',
    async (overlapSeconds) => {
      const c = await context()
      const result = await c.rotate.execute({
        ...c.rotateRequest,
        overlapSeconds,
        requestId: 'request',
      })
      if (result.isLeft()) throw result.value
      expect(result.value.previousKeyValidUntil).toEqual(
        new Date(c.clock.now().getTime() + overlapSeconds * 1000),
      )
      const replacement = c.scope.apiKeyRows.get(result.value.apiKeyId)
      expect(replacement?.issuer()).toBe(c.user.id.toString())
      expect(replacement?.grantedScopes().values).toEqual(c.key.grantedScopes().values)
      expect(c.key.isUsableAt(result.value.previousKeyValidUntil)).toBe(false)
      expect(replacement?.isUsableAt(result.value.previousKeyValidUntil)).toBe(true)
      expect(c.scope.auditRecords.at(-1)).toMatchObject({
        action: 'api-key.rotated',
        requestId: 'request',
      })
    },
  )

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 0.5])(
    'rejects invalid overlap %s',
    async (overlapSeconds) => {
      const c = await context()
      expect((await c.rotate.execute({ ...c.rotateRequest, overlapSeconds })).isLeft()).toBe(true)
      expect(c.scope.apiKeyRows.size).toBe(1)
    },
  )

  it.each(['missing-key', 'missing-issuer', 'role-lost', 'revoked', 'disabled'])(
    'refuses rotation for %s',
    async (scenario) => {
      const c = await context()
      if (scenario === 'missing-key') c.scope.apiKeyRows.clear()
      if (scenario === 'missing-issuer') c.scope.userRows.clear()
      if (scenario === 'role-lost')
        c.user.revokeRole({ module: 'identity', role: 'owner' }, c.clock.now())
      if (scenario === 'revoked') c.key.revoke(c.clock.now())
      if (scenario === 'disabled') c.user.disable(c.clock.now())
      expect((await c.rotate.execute(c.rotateRequest)).isLeft()).toBe(true)
      expect(c.scope.auditRecords).toHaveLength(0)
    },
  )
})
