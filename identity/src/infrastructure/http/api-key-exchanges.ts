import type { Logger } from '@nestjs/common'
import { metrics } from '@opentelemetry/api'
import type { ExchangeApiKeyResponse } from '@/application/use-cases/exchange-api-key'
import {
  ApiKeyRateLimitedError,
  RateLimitUnavailableError,
} from '@/domain/errors/api-key-rate-limited-error'
import { ApiKeyToken } from '@/domain/value-objects/api-key-token'

export type ExchangeOutcome = 'issued' | 'refused' | 'rate-limited' | 'unavailable'

/** No key label: a label per key would grow without bound, and the log names the key instead. */
const exchanges = metrics
  .getMeter('identity.api-keys')
  .createCounter('identity_api_key_exchanges', {
    description: 'API key exchanges for access tokens, by outcome',
  })

const OUTCOMES: readonly ExchangeOutcome[] = ['issued', 'refused', 'rate-limited', 'unavailable']
// Every outcome is a series from the start: a counter first seen at 25 shows no increase,
// so without this the first burst after a restart would never fire the alert.
for (const outcome of OUTCOMES) exchanges.add(0, { outcome })

export function outcomeOf(result: ExchangeApiKeyResponse): ExchangeOutcome {
  if (result.isRight()) return 'issued'
  if (result.value instanceof ApiKeyRateLimitedError) return 'rate-limited'
  if (result.value instanceof RateLimitUnavailableError) return 'unavailable'
  return 'refused'
}

/** The key's lookup prefix, which names it without its secret; never the presented value. */
export function keyNameOf(presented: string): string {
  const parsed = ApiKeyToken.parse(presented)
  return parsed.isRight() ? `hz_…${parsed.value.prefix}` : 'an unreadable key'
}

/**
 * Counts every exchange by outcome (Phase 81), so a stolen key's unusual use shows as a burst
 * of refusals or limits (`ApiKeyExchangesRefused`), and logs which key it was.
 */
export function recordExchange(
  result: ExchangeApiKeyResponse,
  presented: string,
  logger: Pick<Logger, 'warn'>,
): ExchangeOutcome {
  const outcome = outcomeOf(result)
  exchanges.add(1, { outcome })
  if (outcome !== 'issued') logger.warn(`API key exchange ${outcome} for ${keyNameOf(presented)}`)
  return outcome
}
