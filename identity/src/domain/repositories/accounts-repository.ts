import type { Account } from '@/domain/entities/account'
import type { User } from '@/domain/entities/user'
import type { Email } from '@/domain/value-objects/email'

export interface WorkspaceMembership {
  readonly accountId: string
  readonly tenantId: string
  readonly userId: string
  readonly slug: string
  readonly name: string
}

export interface LegacyMembership {
  readonly tenantId: string
  readonly slug: string
  readonly name: string
  readonly user: User
}

/** Global authentication index plus the account-to-workspace selection surface. */
export abstract class AccountsRepository {
  abstract findById(accountId: string): Promise<Account | null>
  abstract findByEmail(email: Email): Promise<Account | null>
  abstract findLegacyMemberships(email: Email): Promise<readonly LegacyMembership[]>
  abstract provisionFromLegacy(email: Email, membership: LegacyMembership): Promise<Account>
  abstract reconcileMemberships(
    accountId: string,
    memberships: readonly LegacyMembership[],
  ): Promise<void>
  abstract listWorkspaces(accountId: string): Promise<readonly WorkspaceMembership[]>
  abstract findMembership(accountId: string, tenantId: string): Promise<WorkspaceMembership | null>
  abstract findAccountIdByMembership(tenantId: string, userId: string): Promise<string | null>
  abstract save(account: Account): Promise<void>
}
