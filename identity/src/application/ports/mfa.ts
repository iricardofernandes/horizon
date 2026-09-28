import type { Invitation } from '@/domain/mfa/invitation'
import type { AuthMethod, MfaPolicy } from '@/domain/mfa/mfa-policy'

/** A second factor of an account (ADR 0061 §2). Secrets are sealed; codes never stored. */
export interface StoredFactor {
  readonly id: string
  readonly accountId: string
  readonly kind: 'totp' | 'passkey'
  readonly label: string
  /** The TOTP secret, sealed with the secret box. */
  readonly secretSealed: string | null
  /** A passkey's credential, base64url. */
  readonly credentialId: string | null
  readonly publicKey: string | null
  readonly signCount: number
  readonly transports: readonly string[]
  readonly confirmedAt: Date | null
  readonly lastUsedStep: number | null
  readonly lastUsedAt: Date | null
  readonly createdAt: Date
}

/** Account-scoped: every call runs as that account (`app.current_account`). */
export abstract class FactorStore {
  /** Active and pending factors, never removed ones. */
  abstract list(accountId: string): Promise<StoredFactor[]>
  abstract insert(factor: StoredFactor): Promise<void>
  abstract confirm(accountId: string, factorId: string, step: number, now: Date): Promise<boolean>
  /** Records a TOTP step, only if it is later than the last one: false when replayed. */
  abstract useTotpStep(
    accountId: string,
    factorId: string,
    step: number,
    now: Date,
  ): Promise<boolean>
  abstract usePasskey(
    accountId: string,
    factorId: string,
    signCount: number,
    now: Date,
  ): Promise<void>
  abstract remove(accountId: string, factorId: string, now: Date): Promise<boolean>
  abstract replaceRecoveryCodes(
    accountId: string,
    digests: readonly string[],
    now: Date,
  ): Promise<void>
  /** Marks one unused code used; false when unknown or already used. */
  abstract useRecoveryCode(accountId: string, digest: string, now: Date): Promise<boolean>
  abstract remainingRecoveryCodes(accountId: string): Promise<number>
}

export type ChallengePurpose = 'login' | 'enrollment'

export interface Challenge {
  readonly accountId: string
  readonly purpose: ChallengePurpose
  /** The WebAuthn challenge in flight, if a passkey ceremony started. */
  readonly webauthn: string | null
}

/** Short-lived proofs between two steps: a password verified, or an enrollment allowed. */
export abstract class MfaChallenges {
  abstract issue(
    accountId: string,
    purpose: ChallengePurpose,
  ): Promise<{ token: string; expiresAt: Date }>
  abstract resolve(token: string): Promise<Challenge | null>
  abstract setWebauthn(token: string, challenge: string): Promise<void>
  abstract consume(token: string): Promise<Challenge | null>
  /** A WebAuthn challenge for a signed-in person, keyed by their account. */
  abstract rememberWebauthn(accountId: string, challenge: string): Promise<void>
  abstract takeWebauthn(accountId: string): Promise<string | null>
}

/** Wrong second factors count here; enough of them lock the account's second factor. */
export abstract class MfaLockout {
  abstract isLocked(accountId: string): Promise<boolean>
  abstract fail(accountId: string): Promise<{ locked: boolean; failures: number }>
  abstract clear(accountId: string): Promise<void>
}

export interface MailMessage {
  readonly to: string
  readonly subject: string
  readonly text: string
}

/** The outbound mail port (ADR 0061): SMTP to Mailpit locally, memory in tests. */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>
}

export interface PasskeyCredential {
  readonly id: string
  readonly publicKey: string
  readonly signCount: number
  readonly transports: readonly string[]
}

/** WebAuthn ceremonies. The options and responses are the browser's JSON, passed through. */
export abstract class Passkeys {
  abstract registrationOptions(input: {
    accountId: string
    userName: string
    exclude: readonly PasskeyCredential[]
  }): Promise<{ options: unknown; challenge: string }>
  abstract verifyRegistration(
    response: unknown,
    challenge: string,
  ): Promise<PasskeyCredential | null>
  abstract authenticationOptions(
    allow: readonly PasskeyCredential[],
  ): Promise<{ options: unknown; challenge: string }>
  /** The credential used and its new counter, or null when the assertion does not verify. */
  abstract verifyAuthentication(
    response: unknown,
    challenge: string,
    credentials: readonly PasskeyCredential[],
  ): Promise<{ id: string; signCount: number } | null>
}

export interface SessionMeta {
  readonly familyId: string
  readonly tenantId: string
  readonly userId: string
  readonly device: string
  readonly ipPrefix: string | null
  readonly amr: readonly AuthMethod[]
  readonly authTime: Date
  readonly createdAt: Date
  readonly lastUsedAt: Date
}

/**
 * What a person sees of their sessions, and the access tokens each one issued: ending a
 * session denylists them (ADR 0061 §5).
 */
export abstract class SessionRegistry {
  abstract open(meta: SessionMeta, deadline: Date): Promise<void>
  abstract find(tenantId: string, familyId: string): Promise<SessionMeta | null>
  abstract touch(tenantId: string, familyId: string, now: Date): Promise<void>
  abstract reauthenticate(
    tenantId: string,
    familyId: string,
    amr: readonly AuthMethod[],
    authTime: Date,
  ): Promise<void>
  abstract recordToken(
    tenantId: string,
    familyId: string,
    jti: string,
    expiresAt: Date,
  ): Promise<void>
  /** The session's tokens still alive now. */
  abstract liveTokens(
    tenantId: string,
    familyId: string,
    now: Date,
  ): Promise<{ jti: string; expiresAt: Date }[]>
  abstract forget(tenantId: string, familyId: string): Promise<void>
}

/** Tenant-scoped invitations and the workspace MFA policy. */
export abstract class InvitationStore {
  abstract insert(invitation: Invitation): Promise<void>
  abstract find(tenantId: string, id: string): Promise<Invitation | null>
  /** Finds by token digest across tenants, through a digest index only (no other data). */
  abstract findByDigest(tokenDigest: string): Promise<Invitation | null>
  abstract list(tenantId: string): Promise<Invitation[]>
  abstract save(invitation: Invitation): Promise<void>
  /** Writes `next` only while `current` is still pending with the same link: false otherwise. */
  abstract claim(current: Invitation, next: Invitation): Promise<boolean>
}

export abstract class MfaPolicies {
  abstract find(tenantId: string): Promise<MfaPolicy>
  abstract save(tenantId: string, policy: MfaPolicy): Promise<void>
}
