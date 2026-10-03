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
import { type PasswordAttempts, penaltyMs } from '../ports/password-attempts'
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

export interface WorkspaceChoice {
  readonly selectionToken: string
  readonly selectionExpiresAt: Date
  readonly workspaces: readonly SelectableWorkspace[]
}

/** The password was right and the account has a second factor: it is asked next (Phase 67). */
export interface SecondFactorChallenge {
  readonly mfaRequired: true
  readonly challengeToken: string
  readonly challengeExpiresAt: Date
  readonly methods: readonly ('totp' | 'recovery' | 'passkey')[]
}

export type AuthenticateAccountResponse = Either<
  InvalidCredentialsError | AccountDisabledError,
  WorkspaceChoice | SecondFactorChallenge
>

/** How the account asks for its second factor, when it has one. */
export interface SecondFactorGate {
  methodsOf(accountId: string): Promise<readonly ('totp' | 'recovery' | 'passkey')[]>
  hasActiveFactor(accountId: string): Promise<boolean>
  issueChallenge(accountId: string): Promise<{ token: string; expiresAt: Date }>
}

/** Password first, tenant second. No tenant-bearing credential exists before selection. */
export class AuthenticateAccountUseCase {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly hasher: PasswordHasher,
    private readonly selections: WorkspaceSelections,
    private readonly policy: IdentityPolicy,
    private readonly clock: Clock,
    private readonly secondFactor?: SecondFactorGate,
    private readonly guessing?: {
      attempts: PasswordAttempts
      sleep(milliseconds: number): Promise<void>
    },
  ) {}

  /**
   * Each wrong password for an account name makes the next attempt wait longer (Phase 92),
   * whatever address it comes from; the right one clears the count.
   */
  async execute(request: AuthenticateAccountRequest): Promise<AuthenticateAccountResponse> {
    if (!this.guessing) return this.authenticate(request)
    const { attempts, sleep } = this.guessing
    const wait = penaltyMs(await attempts.failures(request.email))
    if (wait > 0) await sleep(wait)
    const outcome = await this.authenticate(request)
    if (outcome.isLeft() && outcome.value instanceof InvalidCredentialsError)
      await attempts.failed(request.email)
    else if (outcome.isRight()) await attempts.cleared(request.email)
    return outcome
  }

  private async authenticate(
    request: AuthenticateAccountRequest,
  ): Promise<AuthenticateAccountResponse> {
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

    if (!account.canAuthenticate()) {
      // A disabled account says so only to whoever proved all it asks for. With a second
      // factor still unproved, it answers as a wrong password would (Phase 92).
      const guarded = await this.secondFactor?.hasActiveFactor(account.id.toString())
      return left(guarded ? new InvalidCredentialsError() : new AccountDisabledError())
    }
    const now = this.clock.now()
    await this.upgradeHashIfBelowPolicy(account, request.password, now)
    account.recordSuccessfulLogin(now)
    await this.accounts.save(account)
    const verifiedMemberships = await this.verifiedMemberships(legacyMemberships, request.password)
    await this.accounts.reconcileMemberships(account.id.toString(), verifiedMemberships)

    const memberships = await this.accounts.listWorkspaces(account.id.toString())
    if (memberships.length === 0)
      return left(new AccountDisabledError('this account has no active workspace memberships'))
    const accountId = account.id.toString()
    if (this.secondFactor && (await this.secondFactor.hasActiveFactor(accountId))) {
      const challenge = await this.secondFactor.issueChallenge(accountId)
      return right({
        mfaRequired: true,
        challengeToken: challenge.token,
        challengeExpiresAt: challenge.expiresAt,
        methods: await this.secondFactor.methodsOf(accountId),
      })
    }
    const selection = await this.selections.issue(accountId, { amr: ['pwd'], authTime: now })
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
