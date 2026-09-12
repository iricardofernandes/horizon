import type Redis from 'ioredis'
import { redisKeys } from './redis-keys'

export type DenylistVerdict = 'allowed' | 'denied' | 'unavailable'

/**
 * Read-only: Identity revokes, every module checks (ADR 0021).
 *
 * An outage is reported as a verdict rather than swallowed, because the caller — not
 * this adapter — owns the asymmetric policy: closed for writes and privileged reads,
 * open for the non-privileged reads that say so explicitly.
 */
export class RedisTokenDenylist {
  constructor(private readonly redis: Redis) {}

  async check(jti: string): Promise<DenylistVerdict> {
    return this.checkKey(redisKeys.deniedToken(jti))
  }

  async checkSubject(subject: string): Promise<DenylistVerdict> {
    return this.checkKey(redisKeys.deniedSubject(subject))
  }

  private async checkKey(key: string): Promise<DenylistVerdict> {
    try {
      return (await this.redis.exists(key)) === 1 ? 'denied' : 'allowed'
    } catch {
      return 'unavailable'
    }
  }
}
