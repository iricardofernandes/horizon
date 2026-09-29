import { UseCaseError } from '@/core/errors/use-case-error'

/** A key exchanged more often than its limit allows in the current minute (ADR 0064). */
export class ApiKeyRateLimitedError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/api-key-rate-limited'
  readonly title = 'API key rate limit exceeded'

  constructor(readonly retryAfterSeconds: number) {
    super(`this key has used its exchanges for this minute; retry in ${retryAfterSeconds} s`)
  }
}

/** The count could not be taken, so the exchange is refused rather than left uncounted. */
export class RateLimitUnavailableError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/rate-limit-unavailable'
  readonly title = 'Rate limit unavailable'

  constructor() {
    super('API key exchanges are temporarily unavailable')
  }
}
