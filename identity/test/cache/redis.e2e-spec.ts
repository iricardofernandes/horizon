import { randomUUID } from 'node:crypto'

import { RedisContainer } from '@testcontainers/redis'
import Redis from 'ioredis'

import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { RefreshTokenFamily } from '@/domain/entities/refresh-token-family'
import { SessionReusedError } from '@/domain/errors/session-reused-error'
import { redisKeys } from '@/infrastructure/cache/redis-keys'
import { RedisRefreshTokenFamiliesRepository } from '@/infrastructure/cache/redis-refresh-token-families-repository'
import { RedisTokenDenylist } from '@/infrastructure/cache/redis-token-denylist'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { IdempotencyStore } from '@/infrastructure/http/idempotency-store'
import { makeRefreshTokenFamily } from '../factories/make-refresh-token-family'
import { refreshSessionContext } from '../support/refresh-session-context'

describe('Redis session storage', () => {
  let redis: Redis
  let secondClient: Redis
  let families: RedisRefreshTokenFamiliesRepository
  let secondRepository: RedisRefreshTokenFamiliesRepository
  let denylist: RedisTokenDenylist

  beforeAll(async () => {
    const url = process.env.REDIS_URL
    if (!url) throw new Error('REDIS_URL must be provided by Testcontainers')
    redis = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    })
    secondClient = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    })
    await Promise.all([redis.connect(), secondClient.connect()])
    families = new RedisRefreshTokenFamiliesRepository(redis)
    secondRepository = new RedisRefreshTokenFamiliesRepository(secondClient)
    denylist = new RedisTokenDenylist(redis)
  })

  afterAll(() => {
    redis?.disconnect()
    secondClient?.disconnect()
  })

  it('round trips session state while isolating identical family and user IDs by tenant', async () => {
    const family = makeRefreshTokenFamily({ createdAt: new Date() })
    const snapshot = family.toSnapshot()
    const otherTenant = randomUUID()
    const other = RefreshTokenFamily.create(
      {
        tenantId: otherTenant,
        userId: snapshot.userId,
        currentDigest: 'different-token-digest',
        createdAt: snapshot.createdAt,
      },
      new UniqueEntityID(snapshot.id),
    )
    await families.create(family, 60)
    await families.create(other, 60)
    expect((await families.findById(snapshot.tenantId, snapshot.id))?.toSnapshot()).toEqual(
      snapshot,
    )
    expect(await families.findAllForUser(randomUUID(), snapshot.userId)).toEqual([])
    expect(await families.findById(randomUUID(), snapshot.id)).toBeNull()
    await expect(families.create(family, 60)).rejects.toThrow('already exists')
    await families.delete(otherTenant, snapshot.id)
    expect(await families.findById(snapshot.tenantId, snapshot.id)).not.toBeNull()
    expect(await families.findAllForUser(otherTenant, snapshot.userId)).toEqual([])
  })

  it('allows exactly one compare-and-swap across separate Redis connections', async () => {
    const family = makeRefreshTokenFamily({ createdAt: new Date() })
    const { tenantId, id } = family.toSnapshot()
    await families.create(family, 60)
    const first = await families.findById(tenantId, id)
    const second = await secondRepository.findById(tenantId, id)
    if (!first || !second) throw new Error('Missing newly created family')
    first.rotateTo({ digest: 'first-winner', sealedReplacement: 'first', now: new Date() })
    second.rotateTo({ digest: 'second-winner', sealedReplacement: 'second', now: new Date() })
    const writes = await Promise.all([
      families.saveIfCurrent(first, 'initial-digest'),
      secondRepository.saveIfCurrent(second, 'initial-digest'),
    ])
    expect(writes.filter(Boolean)).toHaveLength(1)
    const stored = await families.findById(tenantId, id)
    expect(stored?.isCurrent(writes[0] ? 'first-winner' : 'second-winner')).toBe(true)
    expect(stored?.toSnapshot().rotatedDigests).toEqual(['initial-digest'])
  })

  it('returns the same replacement for concurrent refreshes and retains all replay history', async () => {
    const ctx = await refreshSessionContext({ families, denylist, createdAt: new Date() })
    const results = await Promise.all(
      Array.from({ length: 16 }, () => ctx.sut.execute(ctx.request)),
    )
    const tokens = results.map((result) => {
      if (result.isLeft()) throw result.value
      return result.value.refreshToken
    })
    expect(new Set(tokens).size).toBe(1)
    let current = tokens[0]
    if (!current) throw new Error('No refresh token issued')
    for (let rotation = 0; rotation < 3; rotation++) {
      const result = await ctx.sut.execute({ ...ctx.request, refreshToken: current })
      if (result.isLeft()) throw result.value
      current = result.value.refreshToken
    }
    const stored = await secondRepository.findById(ctx.request.tenantId, ctx.request.familyId)
    expect(stored?.toSnapshot().rotatedDigests).toHaveLength(4)
    expect(stored?.wasRotatedFrom('digest:initial')).toBe(true)
    const guessed = await ctx.sut.execute({ ...ctx.request, refreshToken: 'unrecognized' })
    expect(guessed.isLeft()).toBe(true)
    expect(await families.findById(ctx.request.tenantId, ctx.request.familyId)).not.toBeNull()
    expect(await denylist.checkSubject(ctx.user.id.toString())).toBe('allowed')
    expect((await ctx.sut.execute(ctx.request)).value).toBeInstanceOf(SessionReusedError)
    expect(await families.findById(ctx.request.tenantId, ctx.request.familyId)).toBeNull()
    expect(ctx.audit.append).toHaveBeenCalledTimes(1)
    expect(ctx.outbox.publish).toHaveBeenCalledTimes(1)
    expect(await denylist.checkSubject(ctx.user.id.toString())).toBe('denied')
  })

  it('does not resurrect a revoked family when another connection saves an old snapshot', async () => {
    const family = makeRefreshTokenFamily({ createdAt: new Date() })
    const { tenantId, userId, id } = family.toSnapshot()
    await families.create(family, 60)
    const stale = await secondRepository.findById(tenantId, id)
    if (!stale) throw new Error('Missing newly created family')
    await families.delete(tenantId, id)
    stale.rotateTo({ digest: 'resurrected', sealedReplacement: 'sealed', now: new Date() })
    expect(await secondRepository.saveIfCurrent(stale, 'initial-digest')).toBe(false)
    expect(await families.findById(tenantId, id)).toBeNull()
    expect(await families.findAllForUser(tenantId, userId)).toEqual([])
  })

  it('preserves the exact absolute deadline through rotation and expires history and index entries', async () => {
    const createdAt = new Date()
    const family = makeRefreshTokenFamily({ createdAt })
    const { tenantId, userId, id } = family.toSnapshot()
    const longerLived = makeRefreshTokenFamily({ tenantId, userId, createdAt })
    await families.create(family, 1)
    await families.create(longerLived, 30)
    const key = redisKeys.family(tenantId, id)
    const deadline = createdAt.getTime() + 1000
    expect(await redis.pexpiretime(key)).toBe(deadline)
    family.rotateTo({ digest: 'next', sealedReplacement: 'sealed', now: new Date() })
    expect(await families.saveIfCurrent(family, 'initial-digest')).toBe(true)
    expect(await redis.pexpiretime(key)).toBe(deadline)
    expect(await redis.pexpiretime(redisKeys.userFamilies(tenantId, userId))).toBe(
      createdAt.getTime() + 30_000,
    )
    await expect.poll(() => families.findById(tenantId, id), { timeout: 3000 }).toBeNull()
    expect(await families.saveIfCurrent(family, 'next')).toBe(false)
    const remaining = await families.findAllForUser(tenantId, userId)
    expect(remaining.map((entry) => entry.id.toString())).toEqual([longerLived.id.toString()])
    expect(await redis.zrange(redisKeys.userFamilies(tenantId, userId), '0', '-1')).toEqual([
      longerLived.id.toString(),
    ])
    await families.delete(tenantId, longerLived.id.toString())
    expect(await redis.exists(redisKeys.userFamilies(tenantId, userId))).toBe(0)
  })

  it('bounds token and subject revocation by expiration without shortening previous revocations', async () => {
    const jti = randomUUID()
    const deadline = new Date(Date.now() + 1000)
    expect(await denylist.check(jti)).toBe('allowed')
    expect(await denylist.checkSubject(jti)).toBe('allowed')
    await denylist.revoke(jti, deadline)
    expect(await denylist.check(jti)).toBe('denied')
    expect(await denylist.checkSubject(jti)).toBe('allowed')
    await denylist.revokeSubject(jti, deadline)
    await Promise.all([
      denylist.revoke(jti, new Date(deadline.getTime() - 500)),
      denylist.revokeSubject(jti, new Date(deadline.getTime() - 500)),
    ])
    expect(await denylist.checkSubject(jti)).toBe('denied')
    expect(await redis.pexpiretime(redisKeys.deniedToken(jti))).toBe(deadline.getTime())
    expect(await redis.pexpiretime(redisKeys.deniedSubject(jti))).toBe(deadline.getTime())
    await expect.poll(() => denylist.check(jti), { timeout: 3000 }).toBe('allowed')
    expect(await denylist.checkSubject(jti)).toBe('allowed')
    await denylist.revoke(jti, new Date(0))
    expect(await denylist.check(jti)).toBe('allowed')
  })

  it('reports Redis outages as unavailable on checks and rejects session and revocation writes', async () => {
    const isolated = await new RedisContainer('redis:7-alpine').start()
    const unavailableRedis = new Redis(isolated.getConnectionUrl(), {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    })
    unavailableRedis.on('error', () => undefined)
    try {
      await unavailableRedis.connect()
      const unavailableDenylist = new RedisTokenDenylist(unavailableRedis)
      const unavailableFamilies = new RedisRefreshTokenFamiliesRepository(unavailableRedis)
      const unavailableIdempotency = new IdempotencyStore(
        unavailableRedis,
        new AesGcmSecretBox(),
        randomUUID(),
      )
      expect(await unavailableDenylist.check('test')).toBe('allowed')
      await isolated.stop()
      expect(await unavailableDenylist.check('test')).toBe('unavailable')
      expect(await unavailableDenylist.checkSubject('test')).toBe('unavailable')
      await expect(
        unavailableDenylist.revoke('test', new Date(Date.now() + 60_000)),
      ).rejects.toThrow()
      await expect(unavailableFamilies.findById('tenant', 'family')).rejects.toThrow()
      await expect(
        unavailableIdempotency.begin({
          tenantId: 'tenant',
          principal: 'user',
          endpoint: 'POST /write',
          key: 'retry',
          body: {},
        }),
      ).rejects.toThrow('Idempotency storage is unavailable')
    } finally {
      unavailableRedis.disconnect()
      await isolated.stop()
    }
  })
})
