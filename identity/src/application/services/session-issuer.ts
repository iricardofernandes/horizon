import { Injectable } from '@nestjs/common'

import { RefreshTokenFamily } from '@/domain/entities/refresh-token-family'
import type { User } from '@/domain/entities/user'
import type { AuthMethod } from '@/domain/mfa/mfa-policy'
import type { RefreshTokenFamiliesRepository } from '@/domain/repositories/refresh-token-families-repository'
import type { SecretBox } from '@/domain/services/secret-box'
import type { TokenDigest } from '@/domain/services/token-digest'
import type { AccessTokenSigner, TokenContext } from '../ports/access-token-signer'
import type { IdentityPolicy } from '../ports/identity-policy'
import type { SessionRegistry } from '../ports/mfa'
import type { SecretGenerator } from '../ports/secret-generator'

/** 32 bytes. Not a UUIDv7: a v7 encodes its creation time and has less entropy (ADR 0020). */
const REFRESH_TOKEN_BYTES = 32

/** Where and how a session was opened (Phase 67). */
export interface SessionOrigin {
  readonly device: string
  readonly ipPrefix: string | null
  readonly amr: readonly AuthMethod[]
  readonly authTime: Date
}

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
    /** Present in the running service; tests of other concerns leave it out. */
    private readonly registry?: SessionRegistry,
  ) {}

  /** A new family. One per login, which is to say one per device. */
  async open(user: User, now: Date, origin?: SessionOrigin): Promise<IssuedSession> {
    const refreshToken = this.secrets.token(REFRESH_TOKEN_BYTES)
    const family = RefreshTokenFamily.open({
      tenantId: user.claims().tenantId,
      userId: user.claims().subject,
      currentDigest: this.digest.digest(refreshToken),
      now,
    })

    const absoluteTtlSeconds = this.policy.session().absoluteTtlSeconds
    await this.families.create(family, absoluteTtlSeconds)
    const familyId = family.id.toString()
    await this.registry?.open(
      {
        familyId,
        tenantId: user.claims().tenantId,
        userId: user.claims().subject,
        device: origin?.device ?? 'Unknown device',
        ipPrefix: origin?.ipPrefix ?? null,
        amr: origin?.amr ?? ['pwd'],
        authTime: origin?.authTime ?? now,
        createdAt: now,
        lastUsedAt: now,
      },
      new Date(now.getTime() + absoluteTtlSeconds * 1000),
    )
    return this.mintFor(user, familyId, refreshToken, now)
  }

  /** The claims a session adds to its tokens, from what the registry holds of it. */
  private async contextOf(tenantId: string, familyId: string): Promise<TokenContext | undefined> {
    if (!this.registry) return undefined
    const meta = await this.registry.find(tenantId, familyId)
    return meta
      ? { sid: familyId, amr: meta.amr, authTime: meta.authTime }
      : { sid: familyId, amr: ['pwd'], authTime: new Date(0) }
  }

  /** Mints for a session and remembers the token, so ending the session can kill it. */
  async mintForSession(user: User, familyId: string, now: Date) {
    const tenantId = user.claims().tenantId
    const minted = await this.signer.mint(
      user.claims(),
      now,
      await this.contextOf(tenantId, familyId),
    )
    await this.registry?.recordToken(tenantId, familyId, minted.jti, minted.expiresAt)
    await this.registry?.touch(tenantId, familyId, now)
    return minted
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
  ): Promise<IssuedSession | null> {
    const expectedDigest = family.currentDigest()
    const refreshToken = this.secrets.token(REFRESH_TOKEN_BYTES)

    const rotated = family.rotateTo({
      digest: this.digest.digest(refreshToken),
      sealedReplacement: this.secretBox.seal(presentedToken, refreshToken),
      now,
    })
    if (rotated.isLeft()) return null
    if (!(await this.families.saveIfCurrent(family, expectedDigest))) return null
    return this.mintFor(user, family.id.toString(), refreshToken, now)
  }

  /**
   * An access token and nothing else — the grace-window answer, where the refresh token
   * is the one already issued and the family must not advance.
   */
  async mintAccessOnly(
    user: User,
    now: Date,
    familyId?: string,
  ): Promise<Pick<IssuedSession, 'accessToken' | 'accessTokenExpiresAt' | 'jti'>> {
    const minted = familyId
      ? await this.mintForSession(user, familyId, now)
      : await this.signer.mint(user.claims(), now)
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
    const minted = await this.mintForSession(user, familyId, now)
    return {
      accessToken: minted.token,
      accessTokenExpiresAt: minted.expiresAt,
      jti: minted.jti,
      refreshToken,
      familyId,
    }
  }
}
