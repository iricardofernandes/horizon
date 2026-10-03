import type Redis from 'ioredis'
import { PasswordAttempts } from '@/application/ports/password-attempts'
import { redisKeys } from './redis-keys'

/** Failures are forgotten fifteen minutes after the last one. */
const FORGOTTEN_AFTER_SECONDS = 900

export class RedisPasswordAttempts extends PasswordAttempts {
  constructor(private readonly redis: Redis) {
    super()
  }

  async failures(email: string): Promise<number> {
    const counted = Number(await this.redis.get(redisKeys.passwordAttempts(email)))
    return Number.isSafeInteger(counted) && counted > 0 ? counted : 0
  }

  async failed(email: string): Promise<void> {
    const key = redisKeys.passwordAttempts(email)
    await this.redis.multi().incr(key).expire(key, FORGOTTEN_AFTER_SECONDS).exec()
  }

  async cleared(email: string): Promise<void> {
    await this.redis.del(redisKeys.passwordAttempts(email))
  }
}
