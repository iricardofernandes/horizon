import { type Either, left, right } from '@/core/either'
import { AccountDisabledError } from '@/domain/errors/account-disabled-error'
import { InvalidCredentialsError } from '@/domain/errors/invalid-credentials-error'
import { type MfaLockedError, StepUpRequiredError } from '@/domain/errors/mfa-errors'
import { type AuthMethod, hasSecondFactor } from '@/domain/mfa/mfa-policy'
import type { AccountsRepository } from '@/domain/repositories/accounts-repository'
import type { PasswordHasher } from '@/domain/services/password-hasher'
import type { AccessTokenSigner } from '../../ports/access-token-signer'
import type { Clock } from '../../ports/clock'
import type { MfaLockout, SessionRegistry } from '../../ports/mfa'
import type { UnitOfWork } from '../../ports/unit-of-work'
import type { CodeMethod, SecondFactors } from './second-factors'

/** A sensitive action needs a proof this recent (ADR 0061 §4). */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000

export interface StepUpRequest {
  readonly tenantId: string
  readonly userId: string
  readonly sid: string | null
  readonly password: string
  readonly method?: CodeMethod
  readonly code?: string
  readonly requestId: string | null
}

type Failure = InvalidCredentialsError | MfaLockedError | AccountDisabledError | StepUpRequiredError

/**
 * Proving again who one is, for the current session: the password, and the second factor
 * when the account has one. The answer is a new access token with `auth_time` now, and
 * the session remembers it, so a refresh keeps it until it ages out.
 */
export class StepUpUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly accounts: AccountsRepository,
    private readonly hasher: PasswordHasher,
    private readonly factors: SecondFactors,
    private readonly lockout: MfaLockout,
    private readonly signer: AccessTokenSigner,
    private readonly registry: SessionRegistry,
    private readonly clock: Clock,
  ) {}

  async execute(
    request: StepUpRequest,
  ): Promise<Either<Failure, { accessToken: string; accessTokenExpiresAt: Date; amr: string[] }>> {
    if (!request.sid) return left(new StepUpRequiredError('only a signed-in session can step up'))
    const accountId = await this.accounts.findAccountIdByMembership(
      request.tenantId,
      request.userId,
    )
    const account = accountId ? await this.accounts.findById(accountId) : null
    if (!accountId || !account) return left(new AccountDisabledError())
    if (!(await account.verifyPassword(request.password, this.hasher))) {
      await this.lockout.fail(accountId)
      return left(new InvalidCredentialsError())
    }
    const amr: AuthMethod[] = ['pwd']
    if (await this.factors.hasActiveFactor(accountId)) {
      if (!request.method || !request.code) return left(new StepUpRequiredError())
      const proved = await this.factors.verifyCode(accountId, request.method, request.code)
      if (proved.isLeft()) return left(proved.value)
      amr.push(proved.value)
    }
    return right(await this.mint(request, amr))
  }

  private async mint(request: StepUpRequest, amr: AuthMethod[]) {
    const now = this.clock.now()
    const sid = request.sid ?? ''
    const user = await this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const found = await scope.users.findById(request.userId)
      await scope.audit.append({
        actor: { type: 'user', id: request.userId },
        subjectType: 'session',
        subjectId: sid,
        action: 'session.stepped-up',
        after: { amr },
        requestId: request.requestId,
        occurredAt: now,
      })
      return found
    })
    if (!user) throw new Error('The user of a live session disappeared')
    await this.registry.reauthenticate(request.tenantId, sid, amr, now)
    const minted = await this.signer.mint(user.claims(), now, { sid, amr, authTime: now })
    await this.registry.recordToken(request.tenantId, sid, minted.jti, minted.expiresAt)
    return { accessToken: minted.token, accessTokenExpiresAt: minted.expiresAt, amr }
  }
}

/**
 * Whether a token proves a recent enough sign-in for a sensitive action: within the window,
 * and with a second factor when the account has one.
 */
export function recentlyAuthenticated(
  token: { readonly amr: readonly string[]; readonly authTime?: Date },
  accountHasFactor: boolean,
  now: Date,
): boolean {
  if (!token.authTime) return false
  if (now.getTime() - token.authTime.getTime() > STEP_UP_WINDOW_MS) return false
  return !accountHasFactor || hasSecondFactor(token.amr)
}
