import type Redis from 'ioredis'

import type { RefreshTokenFamily } from '@/domain/entities/refresh-token-family'
import { RefreshTokenFamiliesRepository } from '@/domain/repositories/refresh-token-families-repository'
import { redisKeys } from './redis-keys'
import { restoreRefreshFamily } from './refresh-family-mapper'

const CREATE = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local deadline = tonumber(ARGV[2])
if deadline <= now then return 0 end
if not redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PXAT', ARGV[2]) then return 0 end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZADD', KEYS[2], deadline, ARGV[3])
if redis.call('PEXPIRETIME', KEYS[2]) < deadline then
  redis.call('PEXPIREAT', KEYS[2], deadline)
end
return 1
`

const SAVE_IF_CURRENT = `
local stored = redis.call('GET', KEYS[1])
if not stored then return 0 end
local family = cjson.decode(stored)
if family.status ~= 'active' or family.currentDigest ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'XX', 'KEEPTTL')
return 1
`

const DELETE = `
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`

const USER_FAMILIES = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
return redis.call('ZRANGE', KEYS[1], 0, -1)
`

/**
 * The family and its complete digest history share one absolute TTL. CAS uses a
 * single Lua command, so racing refreshes cannot advance the same token twice and
 * a delayed writer cannot recreate a revoked session. Redis errors propagate:
 * session extension always fails closed (ADR 0020).
 */
export class RedisRefreshTokenFamiliesRepository extends RefreshTokenFamiliesRepository {
  constructor(private readonly redis: Redis) {
    super()
  }

  async findById(tenantId: string, familyId: string): Promise<RefreshTokenFamily | null> {
    const stored = await this.redis.get(redisKeys.family(tenantId, familyId))
    return stored === null ? null : restoreRefreshFamily(stored, tenantId, familyId)
  }

  async create(family: RefreshTokenFamily, absoluteTtlSeconds: number): Promise<void> {
    if (!Number.isSafeInteger(absoluteTtlSeconds) || absoluteTtlSeconds <= 0)
      throw new Error('Session absolute TTL must be a positive integer')
    const snapshot = family.toSnapshot()
    const deadline = snapshot.createdAt.getTime() + absoluteTtlSeconds * 1000
    const created = await this.redis.eval(
      CREATE,
      2,
      redisKeys.family(snapshot.tenantId, snapshot.id),
      redisKeys.userFamilies(snapshot.tenantId, snapshot.userId),
      JSON.stringify(snapshot),
      deadline,
      snapshot.id,
    )
    if (created !== 1) throw new Error('Refresh family already exists or has expired')
  }

  async saveIfCurrent(family: RefreshTokenFamily, expectedDigest: string): Promise<boolean> {
    const snapshot = family.toSnapshot()
    const saved = await this.redis.eval(
      SAVE_IF_CURRENT,
      1,
      redisKeys.family(snapshot.tenantId, snapshot.id),
      expectedDigest,
      JSON.stringify(snapshot),
    )
    return saved === 1
  }

  async delete(tenantId: string, familyId: string): Promise<void> {
    const family = await this.findById(tenantId, familyId)
    if (family === null) return
    await this.redis.eval(
      DELETE,
      2,
      redisKeys.family(tenantId, familyId),
      redisKeys.userFamilies(tenantId, family.userId()),
      familyId,
    )
  }

  async findAllForUser(tenantId: string, userId: string): Promise<readonly RefreshTokenFamily[]> {
    const ids = await this.redis.eval(USER_FAMILIES, 1, redisKeys.userFamilies(tenantId, userId))
    if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string'))
      throw new Error('Invalid refresh family index')
    const families = await Promise.all(ids.map((id) => this.findById(tenantId, id)))
    return families.filter(
      (family): family is RefreshTokenFamily => family !== null && family.userId() === userId,
    )
  }
}
