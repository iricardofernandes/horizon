export type RateVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number }

/**
 * Exchanges per key per minute (ADR 0064). Counted after the key is verified, so a wrong
 * secret spends nobody's allowance. Throws when the count cannot be taken.
 */
export abstract class ApiKeyRateLimiter {
  abstract consume(apiKeyId: string, now: Date): Promise<RateVerdict>
}
