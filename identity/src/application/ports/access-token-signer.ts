import type { Either } from '@/core/either'
import type { UseCaseError } from '@/core/errors/use-case-error'
import type { UserClaims } from '@/domain/entities/user'

export interface MintedAccessToken {
  readonly token: string
  readonly jti: string
  readonly issuedAt: Date
  readonly expiresAt: Date
  readonly kid: string
}

export interface VerifiedAccessToken {
  readonly subject: string
  readonly tenantId: string
  readonly roles: readonly { module: string; role: string }[]
  readonly jti: string
  readonly expiresAt: Date
  /** The session (refresh family); absent on API-key and service tokens. */
  readonly sid?: string
  /** How the person signed in (RFC 8176): `pwd`, plus `otp`, `hwk` or `rec`. */
  readonly amr: readonly string[]
  /** When the person last proved who they are; a step-up renews it. */
  readonly authTime?: Date
}

/** What a session adds to a token: which session, and how and when it was proven. */
export interface TokenContext {
  readonly sid: string
  readonly amr: readonly string[]
  readonly authTime: Date
}

/** One JWKS entry. Public key material only — this is served to the world. */
export interface JsonWebKey {
  readonly kty: string
  readonly crv: string
  readonly x: string
  readonly kid: string
  readonly alg: string
  readonly use: string
}

/**
 * EdDSA (Ed25519) signing and verification (ADR 0018).
 *
 * `verify` pins `alg` to `EdDSA`. A verifier that trusts the token's own `alg` header
 * accepts `none` — that is a test case in this module, not a comment.
 *
 * Rotation is by publishing several `kid` entries with an overlap window longer than the
 * maximum token lifetime: every public key in the configured directory becomes a JWKS
 * entry, and only `JWT_ACTIVE_KID` signs.
 */
export abstract class AccessTokenSigner {
  abstract mint(claims: UserClaims, now: Date, context?: TokenContext): Promise<MintedAccessToken>
  abstract verify(token: string): Promise<Either<UseCaseError, VerifiedAccessToken>>
  abstract jwks(): readonly JsonWebKey[]
  abstract activeKid(): string
}
