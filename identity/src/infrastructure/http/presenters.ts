import type { Either } from '@/core/either'
import type { UseCaseError } from '@/core/errors/use-case-error'
import type { Account } from '@/domain/entities/account'
import type { ApiKey } from '@/domain/entities/api-key'
import type { Tenant } from '@/domain/entities/tenant'
import type { User } from '@/domain/entities/user'

export function unwrap<L extends UseCaseError, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

/** Explicit allowlists: password/secret hashes never enter an HTTP response. */
export function presentUser(user: User) {
  const snapshot = user.toSnapshot()
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    email: snapshot.email,
    name: snapshot.name,
    roles: snapshot.roles,
    status: snapshot.status,
    lastLoginAt: snapshot.lastLoginAt,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  }
}

export function presentApiKey(key: ApiKey) {
  const snapshot = key.toSnapshot()
  return {
    id: snapshot.id,
    name: snapshot.name,
    prefix: snapshot.prefix,
    issuedBy: snapshot.issuedBy,
    scopes: snapshot.scopes,
    status: snapshot.status,
    expiresAt: snapshot.expiresAt,
    lastUsedAt: snapshot.lastUsedAt,
    createdAt: snapshot.createdAt,
  }
}

/** The signed-in person, plus the language they read in. */
export function presentSelf(user: User, account: Account | null) {
  return { ...presentUser(user), preferredLocale: account?.toSnapshot().preferredLocale ?? null }
}

/** The workspace as a company: what it is called, where it is, and what it reports in. */
export function presentWorkspace(tenant: Tenant) {
  const snapshot = tenant.toSnapshot()
  return {
    id: snapshot.id,
    name: snapshot.name,
    slug: snapshot.slug,
    timezone: snapshot.timezone,
    status: snapshot.status,
    baseCurrency: tenant.baseCurrency(),
    company: snapshot.company,
    fiscalProfileRevision: snapshot.fiscalProfileRevision,
    fiscalProfileEffectiveFrom: snapshot.fiscalProfileEffectiveFrom,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  }
}
