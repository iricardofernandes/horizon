import { Injectable } from '@nestjs/common'

import { RefreshTokenFamily } from '@/domain/entities/refresh-token-family'
import type { User } from '@/domain/entities/user'
import type { RefreshTokenFamiliesRepository } from '@/domain/repositories/refresh-token-families-repository'
import type { SecretBox } from '@/domain/services/secret-box'
import type { TokenDigest } from '@/domain/services/token-digest'
import type { AccessTokenSigner } from '../ports/access-token-signer'
import type { IdentityPolicy } from '../ports/identity-policy'
import type { SecretGenerator } from '../ports/secret-generator'

/** 32 bytes. Not a UUIDv7: a v7 encodes its creation time and has less entropy (ADR 0020). */
const REFRESH_TOKEN_BYTES = 32

export interface IssuedSession {
  readonly accessToken: string
  readonly accessTokenExpiresAt: Date
  readonly jti: string
  readonly refreshToken: string
  readonly familyId: string
}

/**
 * Minting an access token and advancing a refresh family — the two lines that
 * authentication and refresh have in common, and that must not drift apart.
 *
 * An application service rather than a use case: it has no failure modes of its own to
 * return, and it is never the thing a controller calls.
 */
@Injectable()
export class SessionIssuer {
  constructor(
    private readonly signer: AccessTokenSigner,
    private readonly families: RefreshTokenFamiliesRepository,
    private readonly digest: TokenDigest,
    private readonly secretBox: SecretBox,
    private readonly secrets: SecretGenerator,
    private readonly policy: IdentityPolicy,
  ) {}

  /** A new family. One per login, which is to say one per device. */
  async open(user: User, now: Date): Promise<IssuedSession> {
    const refreshToken = this.secrets.token(REFRESH_TOKEN_BYTES)
    const family = RefreshTokenFamily.open({
      tenantId: user.claims().tenantId,
      userId: user.claims().subject,
      currentDigest: this.digest.digest(refreshToken),
      now,
    })

    await this.families.save(family, this.policy.session().absoluteTtlSeconds)
    return this.mintFor(user, family.id.toString(), refreshToken, now)
  }

  /**
   * Advance an existing family, sealing the replacement under the token being retired so
   * a racing tab gets the same value back rather than tripping reuse detection
   * (ADR 0020).
   */
  async rotate(
    family: RefreshTokenFamily,
    user: User,
    presentedToken: string,
    now: Date,
  ): Promise<IssuedSession> {
    const refreshToken = this.secrets.token(REFRESH_TOKEN_BYTES)

    family.rotateTo({
      digest: this.digest.digest(refreshToken),
      sealedReplacement: this.secretBox.seal(presentedToken, refreshToken),
      now,
    })

    await this.families.save(
      family,
      family.remainingAbsoluteSeconds(now, this.policy.session().absoluteTtlSeconds),
    )
    return this.mintFor(user, family.id.toString(), refreshToken, now)
  }

  /**
   * An access token and nothing else — the grace-window answer, where the refresh token
   * is the one already issued and the family must not advance.
   */
  async mintAccessOnly(
    user: User,
    now: Date,
  ): Promise<Pick<IssuedSession, 'accessToken' | 'accessTokenExpiresAt' | 'jti'>> {
    const minted = await this.signer.mint(user.claims(), now)
    return {
      accessToken: minted.token,
      accessTokenExpiresAt: minted.expiresAt,
      jti: minted.jti,
    }
  }

  private async mintFor(
    user: User,
    familyId: string,
    refreshToken: string,
    now: Date,
  ): Promise<IssuedSession> {
    const minted = await this.signer.mint(user.claims(), now)
    return {
      accessToken: minted.token,
      accessTokenExpiresAt: minted.expiresAt,
      jti: minted.jti,
      refreshToken,
      familyId,
    }
  }
}
