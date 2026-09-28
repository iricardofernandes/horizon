import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { InvalidCredentialsError } from '@/domain/errors/invalid-credentials-error'
import type { MfaLockedError } from '@/domain/errors/mfa-errors'
import { WorkspaceSelectionExpiredError } from '@/domain/errors/workspace-selection-expired-error'
import type { AuthMethod } from '@/domain/mfa/mfa-policy'
import type { AccountsRepository } from '@/domain/repositories/accounts-repository'
import type { Clock } from '../../ports/clock'
import type { MfaChallenges } from '../../ports/mfa'
import type { WorkspaceSelections } from '../../ports/workspace-selections'
import type { WorkspaceChoice } from '../authenticate-account'
import type { CodeMethod, SecondFactors } from './second-factors'

type Failure = InvalidCredentialsError | MfaLockedError | WorkspaceSelectionExpiredError

/**
 * The second step of signing in (ADR 0061 §2): the challenge from the password step, and a
 * TOTP code, a recovery code or a passkey. What it answers is the workspace choice, which
 * now carries how the person signed in.
 */
export class CompleteSignInUseCase {
  constructor(
    private readonly challenges: MfaChallenges,
    private readonly factors: SecondFactors,
    private readonly selections: WorkspaceSelections,
    private readonly accounts: AccountsRepository,
    private readonly clock: Clock,
  ) {}

  async withCode(
    challengeToken: string,
    method: CodeMethod,
    code: string,
  ): Promise<Either<Failure, WorkspaceChoice>> {
    const challenge = await this.challenges.resolve(challengeToken)
    if (challenge?.purpose !== 'login') return left(new WorkspaceSelectionExpiredError())
    const proved = await this.factors.verifyCode(challenge.accountId, method, code)
    if (proved.isLeft()) return left(proved.value)
    return this.choice(challengeToken, challenge.accountId, proved.value)
  }

  async passkeyOptions(challengeToken: string): Promise<Either<Failure, unknown>> {
    const challenge = await this.challenges.resolve(challengeToken)
    if (challenge?.purpose !== 'login') return left(new WorkspaceSelectionExpiredError())
    const options = await this.factors.passkeyOptions(challenge.accountId)
    if (!options) return left(new InvalidCredentialsError())
    await this.challenges.setWebauthn(challengeToken, options.challenge)
    return right(options.options)
  }

  async withPasskey(
    challengeToken: string,
    response: unknown,
  ): Promise<Either<Failure, WorkspaceChoice>> {
    const challenge = await this.challenges.resolve(challengeToken)
    if (challenge?.purpose !== 'login' || !challenge.webauthn)
      return left(new WorkspaceSelectionExpiredError())
    const proved = await this.factors.verifyPasskey(
      challenge.accountId,
      response,
      challenge.webauthn,
    )
    if (proved.isLeft()) return left(proved.value)
    return this.choice(challengeToken, challenge.accountId, proved.value)
  }

  /** The challenge is spent once, and only on success; its account chooses a workspace. */
  private async choice(
    challengeToken: string,
    accountId: string,
    method: AuthMethod,
  ): Promise<Either<Failure, WorkspaceChoice>> {
    if (!(await this.challenges.consume(challengeToken)))
      return left(new WorkspaceSelectionExpiredError())
    const now = this.clock.now()
    const selection = await this.selections.issue(accountId, {
      amr: ['pwd', method],
      authTime: now,
    })
    const memberships = await this.accounts.listWorkspaces(accountId)
    return right({
      selectionToken: selection.token,
      selectionExpiresAt: selection.expiresAt,
      workspaces: memberships.map(({ tenantId, slug, name }) => ({ tenantId, slug, name })),
    })
  }
}

/**
 * Enrolling a TOTP factor with an enrollment token, when the workspace requires one and the
 * grace period ended (ADR 0061 §3). The token allows nothing else, and is spent on success.
 */
export class EnrollWithTokenUseCase {
  constructor(
    private readonly challenges: MfaChallenges,
    private readonly factors: SecondFactors,
  ) {}

  async start(
    token: string,
    accountLabel: string,
  ): Promise<
    Either<WorkspaceSelectionExpiredError, { factorId: string; secret: string; otpauthUri: string }>
  > {
    const challenge = await this.challenges.resolve(token)
    if (challenge?.purpose !== 'enrollment') return left(new WorkspaceSelectionExpiredError())
    return right(await this.factors.startTotp(challenge.accountId, accountLabel))
  }

  async confirm(
    token: string,
    factorId: string,
    code: string,
  ): Promise<
    Either<
      WorkspaceSelectionExpiredError | ResourceNotFoundError | InvalidInputError,
      { recoveryCodes: string[] | null }
    >
  > {
    const challenge = await this.challenges.resolve(token)
    if (challenge?.purpose !== 'enrollment') return left(new WorkspaceSelectionExpiredError())
    const confirmed = await this.factors.confirmTotp(challenge.accountId, factorId, code)
    if (confirmed.isRight()) await this.challenges.consume(token)
    return confirmed
  }
}
