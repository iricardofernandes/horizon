import type { SessionLifetimes } from '@/domain/entities/refresh-token-family'
import type { Argon2Policy } from '@/domain/value-objects/password-hash'

/**
 * The tunable numbers, as a port.
 *
 * Use cases read policy from here rather than from `ConfigService`, for two reasons: the
 * application layer stays free of `@nestjs/*` (ADR 0031), and a test that needs a
 * two-second idle timeout sets one instead of rewriting the environment.
 */
export abstract class IdentityPolicy {
  abstract argon2(): Argon2Policy
  abstract session(): SessionLifetimes
  abstract accessTokenTtlSeconds(): number
  /** `dev`, `test` or `live` — the `<env>` segment of issued API keys (ADR 0022). */
  abstract apiKeyEnvironment(): string
}
