import { makeApiKey } from 'test/factories/make-api-key'
import { makeUser } from 'test/factories/make-user'
import { identityContext, TEST_HASH, valid } from 'test/support/identity-context'
import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ApiKeyToken } from '../value-objects/api-key-token'
import { PasswordHash } from '../value-objects/password-hash'
import { TenantName } from '../value-objects/tenant-name'
import { Timezone } from '../value-objects/timezone'
import { DataSubjectKey } from './data-subject-key'

describe('identity aggregate lifecycles', () => {
  it('suspends and reinstates a tenant without accepting duplicate transitions', async () => {
    const c = await identityContext()
    expect(c.tenant.reinstate(c.clock.now()).isLeft()).toBe(true)
    expect(c.tenant.suspend(c.clock.now()).isRight()).toBe(true)
    expect(c.tenant.isActive()).toBe(false)
    expect(c.tenant.suspend(c.clock.now()).isLeft()).toBe(true)
    expect(c.tenant.reinstate(c.clock.now()).isRight()).toBe(true)
    c.tenant.rename(valid(TenantName.create('Updated Workspace')), c.clock.now())
    c.tenant.moveTo(valid(Timezone.create('UTC')), c.clock.now())
    expect(snapshotOf(c.tenant)).toMatchObject({
      name: 'Updated Workspace',
      timezone: 'UTC',
      status: 'active',
    })
    expect(Object.isFrozen(snapshotOf(c.tenant))).toBe(true)
  })

  it('can reinstate a disabled user, but erasure is irreversible and clears all roles', async () => {
    const c = await identityContext()
    expect(c.user.reinstate(c.clock.now()).isLeft()).toBe(true)
    expect(c.user.disable(c.clock.now()).isRight()).toBe(true)
    expect(c.user.reinstate(c.clock.now()).isRight()).toBe(true)
    expect(c.user.canAuthenticate()).toBe(true)
    c.user.changePassword(valid(PasswordHash.create(TEST_HASH)), c.clock.now())
    expect(await c.user.verifyPassword('correct', c.hasher)).toBe(true)
    expect(c.user.markErased(c.clock.now()).isRight()).toBe(true)
    expect(c.user.markErased(c.clock.now()).isLeft()).toBe(true)
    expect(c.user.reinstate(c.clock.now()).isLeft()).toBe(true)
    expect(c.user.disable(c.clock.now()).isLeft()).toBe(true)
    expect(c.user.canAuthenticate()).toBe(false)
    expect(c.user.claims().roles).toEqual([])
    expect(Object.isFrozen(snapshotOf(c.user))).toBe(true)
    expect(
      snapshotOf(makeUser({ lastLoginAt: c.clock.now(), updatedAt: c.clock.now() })).lastLoginAt,
    ).toEqual(c.clock.now())
  })

  it('rehydrates an erased subject key without emitting new erasure events', () => {
    const now = new Date('2026-09-10T12:00:00Z')
    const key = DataSubjectKey.create(
      { tenantId: 'tenant', material: null, erasedAt: now },
      new UniqueEntityID(),
    )
    expect(key.isErased()).toBe(true)
    expect(key.destroy(now).isLeft()).toBe(true)
    expect(snapshotOf(key)).toMatchObject({ material: null, erasedAt: now })
    expect(key.pullDomainEvents()).toEqual([])
  })

  it('preserves expiration when rotating and refuses expired or already superseded keys', () => {
    const now = new Date('2026-09-10T12:00:00Z')
    const expiresAt = new Date(now.getTime() + 60000)
    const key = makeApiKey({ expiresAt })
    key.rename('Renamed Integration')
    expect(key.permits('identity:read')).toBe(true)
    expect(key.permits('identity:write')).toBe(false)
    const props = {
      token: ApiKeyToken.create({
        environment: 'test',
        prefix: 'C'.repeat(24),
        secret: 'D'.repeat(32),
      }),
      secretHash: 'new-hash',
      until: new Date(now.getTime() + 1000),
      now,
    }
    expect(key.rotate({ ...props, until: new Date(now.getTime() - 1) }).isLeft()).toBe(true)
    expect(key.rotate({ ...props, until: new Date('invalid') }).isLeft()).toBe(true)
    const replacement = valid(key.rotate(props))
    expect(snapshotOf(replacement)).toMatchObject({ name: 'Renamed Integration', expiresAt })
    expect(replacement.isUsableAt(expiresAt)).toBe(false)
    expect(key.rotate(props).isLeft()).toBe(true)
    expect(key.rotate({ ...props, now: props.until }).isLeft()).toBe(true)
    expect(makeApiKey({ expiresAt: now }).rotate(props).isLeft()).toBe(true)
    const revoked = makeApiKey({
      status: 'revoked',
      revokedAt: now,
      lastUsedAt: now,
      supersededAt: now,
    })
    expect(snapshotOf(revoked)).toMatchObject({
      revokedAt: now,
      lastUsedAt: now,
      supersededAt: now,
    })
  })
})
