import { type Either, left, right } from '@/core/either'
import type { Account } from '@/domain/entities/account'
import { AccountDisabledError } from '@/domain/errors/account-disabled-error'
import { InvalidCredentialsError } from '@/domain/errors/invalid-credentials-error'
import type {
  AccountsRepository,
  LegacyMembership,
} from '@/domain/repositories/accounts-repository'
import type { PasswordHasher } from '@/domain/services/password-hasher'
import { Email } from '@/domain/value-objects/email'
import { PasswordHash } from '@/domain/value-objects/password-hash'
import type { Clock } from '../ports/clock'
import type { IdentityPolicy } from '../ports/identity-policy'
import type { WorkspaceSelections } from '../ports/workspace-selections'

export interface SelectableWorkspace {
  readonly tenantId: string
  readonly slug: string
  readonly name: string
}

export interface AuthenticateAccountRequest {
  readonly email: string
  readonly password: string
}

export type AuthenticateAccountResponse = Either<
  InvalidCredentialsError | AccountDisabledError,
  {
    readonly selectionToken: string
    readonly selectionExpiresAt: Date
    readonly workspaces: readonly SelectableWorkspace[]
  }
>

/** Password first, tenant second. No tenant-bearing credential exists before selection. */
export class AuthenticateAccountUseCase {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly hasher: PasswordHasher,
    private readonly selections: WorkspaceSelections,
    private readonly policy: IdentityPolicy,
    private readonly clock: Clock,
  ) {}

  async execute(request: AuthenticateAccountRequest): Promise<AuthenticateAccountResponse> {
    const email = Email.create(request.email)
    if (email.isLeft()) {
      await this.hasher.verifyDummy()
      return left(new InvalidCredentialsError())
    }

    let account = await this.accounts.findByEmail(email.value)
    let legacyMemberships: readonly LegacyMembership[]
    if (account === null) {
      legacyMemberships = await this.accounts.findLegacyMemberships(email.value)
      if (legacyMemberships.length === 0) {
        await this.hasher.verifyDummy()
        return left(new InvalidCredentialsError())
      }
      const verified = await this.verifiedMemberships(legacyMemberships, request.password)
      const candidate = verified.find(({ user }) => user.canAuthenticate())
      if (!candidate) return left(new InvalidCredentialsError())
      account = await this.accounts.provisionFromLegacy(email.value, candidate)
    } else if (!(await account.verifyPassword(request.password, this.hasher))) {
      return left(new InvalidCredentialsError())
    } else {
      legacyMemberships = await this.accounts.findLegacyMemberships(email.value)
    }

    if (!account.canAuthenticate()) return left(new AccountDisabledError())
    const now = this.clock.now()
    await this.upgradeHashIfBelowPolicy(account, request.password, now)
    account.recordSuccessfulLogin(now)
    await this.accounts.save(account)
    const verifiedMemberships = await this.verifiedMemberships(legacyMemberships, request.password)
    await this.accounts.reconcileMemberships(account.id.toString(), verifiedMemberships)

    const memberships = await this.accounts.listWorkspaces(account.id.toString())
    if (memberships.length === 0)
      return left(new AccountDisabledError('this account has no active workspace memberships'))
    const selection = await this.selections.issue(account.id.toString())
    return right({
      selectionToken: selection.token,
      selectionExpiresAt: selection.expiresAt,
      workspaces: memberships.map(({ tenantId, slug, name }) => ({ tenantId, slug, name })),
    })
  }

  private async verifiedMemberships(
    memberships: readonly LegacyMembership[],
    password: string,
  ): Promise<readonly LegacyMembership[]> {
    const matches = await Promise.all(
      memberships.map(async (membership) => ({
        membership,
        matches: await membership.user.verifyPassword(password, this.hasher),
      })),
    )
    return matches.filter(({ matches }) => matches).map(({ membership }) => membership)
  }

  private async upgradeHashIfBelowPolicy(
    account: Account,
    password: string,
    now: Date,
  ): Promise<void> {
    if (!account.needsRehash(this.policy.argon2())) return
    const rehashed = PasswordHash.create(await this.hasher.hash(password))
    if (rehashed.isRight()) account.upgradePasswordHash(rehashed.value, now)
  }
}
