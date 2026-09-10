import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import type { RefreshTokenFamily } from '@/domain/entities/refresh-token-family'
import type { User } from '@/domain/entities/user'
import { SessionExpiredError } from '@/domain/errors/session-expired-error'
import { SessionReusedError } from '@/domain/errors/session-reused-error'
import type { RefreshTokenFamiliesRepository } from '@/domain/repositories/refresh-token-families-repository'
import type { SecretBox } from '@/domain/services/secret-box'
import type { TokenDigest } from '@/domain/services/token-digest'
import type { Clock } from '../ports/clock'
import type { IdentityPolicy } from '../ports/identity-policy'
import type { TokenDenylist } from '../ports/token-denylist'
import type { TenantScope, UnitOfWork } from '../ports/unit-of-work'
import type { IssuedSession } from '../services/session-issuer'
import { SessionIssuer } from '../services/session-issuer'

export interface RefreshSessionRequest {
  readonly tenantId: string
  readonly familyId: string
  readonly refreshToken: string
  readonly sourceIp?: string | null
  readonly requestId?: string | null
}

export type RefreshSessionResponse = Either<SessionExpiredError | SessionReusedError, IssuedSession>

// Contention is bounded; exhausting retries fails closed without issuing credentials.
const MAX_ROTATION_ATTEMPTS = 5

/**
 * Exchange a refresh token for a new pair, and detect theft while doing it (ADR 0020).
 *
 * Four cases, in the order they are checked:
 *
 *   - **The current token.** Rotate: the family advances and a new pair is returned.
 *   - **The immediately-previous token, inside the grace window.** Two tabs raced a
 *     refresh; return the *same* replacement rather than a new one. It is sealed under
 *     the presented token itself, so the racing tab can open it and a compromised Redis
 *     cannot (see `SecretBox`).
 *   - **Any rotated token, outside the immediately-previous token's grace.** A replay. Kill the family —
 *     both the attacker's session and the legitimate user's — and emit the security
 *     event. A forced re-login is a far better outcome than an undetected persistent
 *     session.
 *   - **Anything else.** Unknown, expired, or already ended.
 *
 * The family is killed in Redis *before* the audit entry is written to PostgreSQL. Those
 * are two systems and the pair is not atomic, so the order is chosen so that the failure
 * mode is a missing log line rather than a live session that should be dead.
 */
@Injectable()
export class RefreshSessionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly families: RefreshTokenFamiliesRepository,
    private readonly denylist: TokenDenylist,
    private readonly digest: TokenDigest,
    private readonly secretBox: SecretBox,
    private readonly sessions: SessionIssuer,
    private readonly policy: IdentityPolicy,
    private readonly clock: Clock,
  ) {}

  async execute(request: RefreshSessionRequest): Promise<RefreshSessionResponse> {
    for (let attempt = 0; attempt < MAX_ROTATION_ATTEMPTS; attempt++) {
      const result = await this.attempt(request)
      if (result !== null) return result
    }
    return left(new SessionExpiredError())
  }

  /** A CAS conflict reloads the winner before applying grace or reuse detection. */
  private async attempt(request: RefreshSessionRequest): Promise<RefreshSessionResponse | null> {
    const now = this.clock.now()
    const family = await this.families.findById(request.tenantId, request.familyId)

    if (family === null || !family.isActive()) return left(new SessionExpiredError())
    if (family.isExpiredAt(now, this.policy.session())) {
      family.end('expired')
      if (!(await this.families.saveIfCurrent(family, family.currentDigest()))) return null
      await this.families.delete(request.tenantId, request.familyId)
      return left(new SessionExpiredError())
    }

    const presented = this.digest.digest(request.refreshToken)

    if (family.isCurrent(presented)) return this.rotate(family, request, now)
    return this.replayed(family, presented, request, now)
  }

  private async rotate(
    family: RefreshTokenFamily,
    request: RefreshSessionRequest,
    now: Date,
  ): Promise<RefreshSessionResponse | null> {
    const user = await this.loadActiveUser(request.tenantId, family.userId())
    if (user === null) {
      family.end('user-disabled')
      await this.families.delete(request.tenantId, request.familyId)
      return left(new SessionExpiredError())
    }

    const session = await this.sessions.rotate(family, user, request.refreshToken, now)
    return session === null ? null : right(session)
  }

  /** Either a benign race inside the grace window, or a theft. */
  private async replayed(
    family: RefreshTokenFamily,
    presented: string,
    request: RefreshSessionRequest,
    now: Date,
  ): Promise<RefreshSessionResponse | null> {
    if (!family.wasRotatedFrom(presented)) return left(new SessionExpiredError())

    const sealed = family.graceReplacementFor(presented, now, this.policy.session().reuseGraceMs)
    if (sealed !== null) {
      const replacement = this.secretBox.open(request.refreshToken, sealed)
      if (replacement !== null) return this.reissueGrace(family, request, replacement, now)
    }

    return this.killFamily(family, request, now)
  }

  /**
   * The racing tab's answer: the identical replacement, and a fresh access token minted
   * for it. Nothing about the family changes, so a third presentation of the same token
   * inside the window gets the same answer again and the chain stays where it is.
   */
  private async reissueGrace(
    family: RefreshTokenFamily,
    request: RefreshSessionRequest,
    replacement: string,
    now: Date,
  ): Promise<RefreshSessionResponse | null> {
    const user = await this.loadActiveUser(request.tenantId, family.userId())
    if (user === null) {
      family.end('user-disabled')
      await this.families.delete(request.tenantId, request.familyId)
      return left(new SessionExpiredError())
    }

    // Validate again after the user lookup: a concurrent rotation or revocation may
    // have invalidated this grace snapshot. CAS preserves the absolute deadline.
    if (!(await this.families.saveIfCurrent(family, family.currentDigest()))) return null
    const minted = await this.sessions.mintAccessOnly(user, now)
    return right({ ...minted, refreshToken: replacement, familyId: request.familyId })
  }

  private async killFamily(
    family: RefreshTokenFamily,
    request: RefreshSessionRequest,
    now: Date,
  ): Promise<RefreshSessionResponse> {
    family.detectReuse(now)
    await this.families.delete(request.tenantId, request.familyId)
    // Access tokens have no family claim. A confirmed replay therefore revokes all
    // outstanding tokens for this subject, including other devices, for one token
    // lifetime. Random guesses never reach this branch (ADR 0021).
    await this.denylist.revokeSubject(
      family.userId(),
      new Date(now.getTime() + this.policy.accessTokenTtlSeconds() * 1000),
    )

    await this.unitOfWork.inTenant(request.tenantId, async (scope: TenantScope) => {
      await scope.audit.append({
        actor: { type: 'user', id: family.userId() },
        subjectType: 'session',
        subjectId: request.familyId,
        action: 'session.reuse-detected',
        requestId: request.requestId ?? null,
        sourceIp: request.sourceIp ?? null,
        occurredAt: now,
      })
      await scope.outbox.publish(family.pullDomainEvents())
    })

    return left(new SessionReusedError())
  }

  private async loadActiveUser(tenantId: string, userId: string): Promise<User | null> {
    return this.unitOfWork.inTenant(tenantId, async (scope) => {
      const user = await scope.users.findById(userId)
      if (user === null || !user.canAuthenticate()) return null
      return user
    })
  }
}
