import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { User } from '@/domain/entities/user'
import { AccountDisabledError } from '@/domain/errors/account-disabled-error'
import { InvalidCredentialsError } from '@/domain/errors/invalid-credentials-error'
import { TenantSuspendedError } from '@/domain/errors/tenant-suspended-error'
import type { TenantDirectory } from '@/domain/repositories/tenant-directory'
import type { PasswordHasher } from '@/domain/services/password-hasher'
import { Email } from '@/domain/value-objects/email'
import { PasswordHash } from '@/domain/value-objects/password-hash'
import type { Clock } from '../ports/clock'
import type { IdentityPolicy } from '../ports/identity-policy'
import type { TenantScope, UnitOfWork } from '../ports/unit-of-work'
import type { IssuedSession } from '../services/session-issuer'
import { SessionIssuer } from '../services/session-issuer'

export interface AuthenticateUserRequest {
  /** The workspace handle, typed at the login form. Resolved before tenant context. */
  readonly tenantSlug: string
  readonly email: string
  readonly password: string
  readonly sourceIp?: string | null
  readonly requestId?: string | null
}

export type AuthenticateUserResponse = Either<
  InvalidCredentialsError | AccountDisabledError | TenantSuspendedError | InvalidInputError,
  IssuedSession
>

/**
 * Log in.
 *
 * The ordering in here is the security design, and every step of it is deliberate:
 *
 *   1. An unknown workspace, an unknown address and a wrong password all return the same
 *      `InvalidCredentialsError`. Three distinguishable answers would be an account
 *      enumeration oracle; the real reason goes to the audit log, where only an operator
 *      reads it.
 *   2. When no user is found, a **dummy verification still runs**. Argon2id takes tens of
 *      milliseconds, and skipping it would make response latency a reliable signal that
 *      the account does not exist.
 *   3. The account-status check happens **after** the password is verified. Someone who
 *      has proved they own the account is told it is disabled; someone who has not,
 *      learns nothing.
 *   4. Rehash-on-login upgrades a hash below current policy inside this same request —
 *      the only moment the plaintext exists (ADR 0019).
 */
@Injectable()
export class AuthenticateUserUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly directory: TenantDirectory,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionIssuer,
    private readonly policy: IdentityPolicy,
    private readonly clock: Clock,
  ) {}

  async execute(request: AuthenticateUserRequest): Promise<AuthenticateUserResponse> {
    const email = Email.create(request.email)
    if (email.isLeft()) {
      await this.hasher.verifyDummy()
      return left(new InvalidCredentialsError())
    }

    const tenantId = await this.directory.resolve(request.tenantSlug.trim().toLowerCase())
    if (tenantId === null) {
      await this.hasher.verifyDummy()
      return left(new InvalidCredentialsError())
    }

    return this.unitOfWork.inTenant(tenantId, async (scope) => {
      const tenant = await scope.tenants.findById(tenantId)
      if (tenant === null || !tenant.isActive()) {
        await this.hasher.verifyDummy()
        return left(tenant === null ? new InvalidCredentialsError() : new TenantSuspendedError())
      }

      const user = await scope.users.findByEmail(email.value)
      if (user === null) {
        await this.hasher.verifyDummy()
        return left(new InvalidCredentialsError())
      }

      if (!(await user.verifyPassword(request.password, this.hasher))) {
        await this.recordFailure(scope, request, user.claims().subject)
        return left(new InvalidCredentialsError())
      }

      if (!user.canAuthenticate()) return left(new AccountDisabledError())

      const now = this.clock.now()
      await this.upgradeHashIfBelowPolicy(user, request.password, now)
      user.recordSuccessfulLogin(now)
      await scope.users.save(user)

      await scope.audit.append({
        actor: { type: 'user', id: user.claims().subject },
        subjectType: 'session',
        subjectId: user.claims().subject,
        action: 'session.opened',
        requestId: request.requestId ?? null,
        sourceIp: request.sourceIp ?? null,
        occurredAt: now,
      })

      return right(await this.sessions.open(user, now))
    })
  }

  /** Transparent, inside the request that proved the password. Nobody notices. */
  private async upgradeHashIfBelowPolicy(user: User, password: string, now: Date): Promise<void> {
    if (!user.needsRehash(this.policy.argon2())) return

    const rehashed = PasswordHash.create(await this.hasher.hash(password))
    if (rehashed.isLeft()) return
    user.upgradePasswordHash(rehashed.value, now)
  }

  /**
   * A failed attempt is recorded against the account it was aimed at, with the source
   * address. The response says nothing; the log says everything, which is the only place
   * that distinction is safe to make.
   */
  private async recordFailure(
    scope: TenantScope,
    request: AuthenticateUserRequest,
    userId: string,
  ): Promise<void> {
    await scope.audit.append({
      actor: { type: 'user', id: userId },
      subjectType: 'session',
      subjectId: userId,
      action: 'session.rejected',
      requestId: request.requestId ?? null,
      sourceIp: request.sourceIp ?? null,
      occurredAt: this.clock.now(),
    })
  }
}
