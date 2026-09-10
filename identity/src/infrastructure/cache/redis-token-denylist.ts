import type Redis from 'ioredis'

import { type DenylistVerdict, TokenDenylist } from '@/application/ports/token-denylist'
import { redisKeys } from './redis-keys'

const REVOKE = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local deadline = tonumber(ARGV[1])
if deadline <= now then return 0 end
local existing = redis.call('PEXPIRETIME', KEYS[1])
if existing == -1 or existing >= deadline then return 0 end
redis.call('SET', KEYS[1], '1', 'PXAT', ARGV[1])
return 1
`

/** Reads expose outages as a verdict; failed revocation writes propagate (ADR 0021). */
export class RedisTokenDenylist extends TokenDenylist {
  constructor(private readonly redis: Redis) {
    super()
  }

  async revoke(jti: string, expiresAt: Date): Promise<void> {
    await this.revokeKey(redisKeys.deniedToken(jti), expiresAt)
  }

  async check(jti: string): Promise<DenylistVerdict> {
    return this.checkKey(redisKeys.deniedToken(jti))
  }

  async revokeSubject(subject: string, until: Date): Promise<void> {
    await this.revokeKey(redisKeys.deniedSubject(subject), until)
  }

  async checkSubject(subject: string): Promise<DenylistVerdict> {
    return this.checkKey(redisKeys.deniedSubject(subject))
  }

  private async revokeKey(key: string, expiresAt: Date): Promise<void> {
    const deadline = expiresAt.getTime()
    if (!Number.isSafeInteger(deadline)) throw new Error('Invalid denylist expiration')
    await this.redis.eval(REVOKE, 1, key, deadline)
  }

  private async checkKey(key: string): Promise<DenylistVerdict> {
    try {
      return (await this.redis.exists(key)) === 1 ? 'denied' : 'allowed'
    } catch {
      return 'unavailable'
    }
  }
}
