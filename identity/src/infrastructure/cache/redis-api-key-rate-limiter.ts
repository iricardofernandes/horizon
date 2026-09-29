import type Redis from 'ioredis'

import { ApiKeyRateLimiter, type RateVerdict } from '@/application/ports/api-key-rate-limiter'

const WINDOW_SECONDS = 60
const segment = (value: string): string => Buffer.from(value).toString('base64url')

/** A fixed window per key and minute; the counter outlives its minute only briefly. */
export class RedisApiKeyRateLimiter extends ApiKeyRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly perMinute: number,
  ) {
    super()
    if (!Number.isSafeInteger(perMinute) || perMinute <= 0)
      throw new Error('The API key rate limit must be a positive integer')
  }

  async consume(apiKeyId: string, now: Date): Promise<RateVerdict> {
    const seconds = Math.floor(now.getTime() / 1000)
    const window = Math.floor(seconds / WINDOW_SECONDS)
    const key = `identity:api-key:rate:${segment(apiKeyId)}:${window}`
    const replies = await this.redis
      .multi()
      .incr(key)
      .expire(key, WINDOW_SECONDS * 2)
      .exec()
    const counted = replies?.[0]
    if (!counted || counted[0] !== null || typeof counted[1] !== 'number')
      throw new Error('the rate limit count was not taken')
    if (counted[1] <= this.perMinute) return { allowed: true }
    return { allowed: false, retryAfterSeconds: WINDOW_SECONDS - (seconds % WINDOW_SECONDS) }
  }
}
