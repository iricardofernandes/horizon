/**
 * Cryptographically secure randomness. One port, so nothing in the module ever reaches
 * for `Math.random()` — the failure that would produce is silent and total.
 */
export abstract class SecretGenerator {
  /** URL-safe, `bytes` of entropy. Refresh tokens are 32 (ADR 0020). */
  abstract token(bytes: number): string

  /** Uniform over `[A-Za-z0-9]`, without modulo bias. API key segments (ADR 0022). */
  abstract alphanumeric(length: number): string

  /** Base64, 32 bytes — one data subject's encryption key (ADR 0026). */
  abstract keyMaterial(): string

  /** The `jti` a token is denylisted by (ADR 0021). */
  abstract identifier(): string
}
