import type { RefreshTokenFamily } from '@/domain/entities/refresh-token-family'

/**
 * Backed by Redis, not PostgreSQL (ADR 0020), which is why it is not part of the tenant
 * transaction. Redis unavailable therefore means no refresh — sessions expire within the
 * access token's 15 minutes — and that is the correct direction to fail for session
 * *extension*. It is a different decision from the denylist's asymmetric behaviour
 * (ADR 0021), which concerns tokens already issued.
 */
export abstract class RefreshTokenFamiliesRepository {
  abstract findById(tenantId: string, familyId: string): Promise<RefreshTokenFamily | null>

  /** Written with a TTL equal to the family's remaining absolute lifetime. */
  abstract save(family: RefreshTokenFamily, ttlSeconds: number): Promise<void>

  abstract delete(tenantId: string, familyId: string): Promise<void>

  /** Every family for a user — what disabling an account has to walk. */
  abstract findAllForUser(tenantId: string, userId: string): Promise<readonly RefreshTokenFamily[]>
}
