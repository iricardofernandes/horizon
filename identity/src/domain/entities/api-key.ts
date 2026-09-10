import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ApiKeyRevokedEvent } from '@/domain/events/api-key-revoked-event'
import type { PasswordHasher } from '@/domain/services/password-hasher'
import type { ApiKeyScopes } from '@/domain/value-objects/api-key-scopes'
import type { ApiKeyToken } from '@/domain/value-objects/api-key-token'

export const API_KEY_STATUSES = ['active', 'revoked'] as const
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number]

interface ApiKeyProps {
  readonly tenantId: string
  /** The user who minted it. A key never outgrows its issuer (ADR 0022). */
  readonly issuedBy: string
  name: string
  readonly environment: string
  readonly prefix: string
  secretHash: string
  scopes: ApiKeyScopes
  status: ApiKeyStatus
  expiresAt?: Date
  lastUsedAt?: Date
  revokedAt?: Date
  /** Set when this key was superseded by a rotation, to the end of the overlap window. */
  supersededAt?: Date
  readonly createdAt: Date
}

export interface ApiKeySnapshot {
  readonly id: string
  readonly tenantId: string
  readonly issuedBy: string
  readonly name: string
  readonly environment: string
  readonly prefix: string
  readonly secretHash: string
  readonly scopes: readonly string[]
  readonly status: ApiKeyStatus
  readonly expiresAt: Date | null
  readonly lastUsedAt: Date | null
  readonly revokedAt: Date | null
  readonly supersededAt: Date | null
  readonly createdAt: Date
}

/**
 * A bearer credential with no interactive refresh, held by a machine (ADR 0022).
 *
 * The secret never lives here. What is stored is the plaintext 24-character prefix —
 * indexed, identifying, useless alone — and an Argon2id hash of the 32-character secret.
 * A key found in a log can be identified and revoked from the prefix without its holder
 * producing it, and lookup is one indexed equality before any hashing cost is paid.
 */
export class ApiKey extends AggregateRoot<ApiKeyProps> {
  /** `last_used_at` is written at most this often per key (ADR 0022). */
  static readonly LAST_USED_THROTTLE_MS = 60_000

  static create(
    props: {
      tenantId: string
      issuedBy: string
      name: string
      environment: string
      prefix: string
      secretHash: string
      scopes: ApiKeyScopes
      status?: ApiKeyStatus
      expiresAt?: Date
      lastUsedAt?: Date
      revokedAt?: Date
      supersededAt?: Date
      createdAt?: Date
    },
    id?: UniqueEntityID,
  ): ApiKey {
    return new ApiKey(
      {
        tenantId: props.tenantId,
        issuedBy: props.issuedBy,
        name: props.name,
        environment: props.environment,
        prefix: props.prefix,
        secretHash: props.secretHash,
        scopes: props.scopes,
        status: props.status ?? 'active',
        ...(props.expiresAt === undefined ? {} : { expiresAt: props.expiresAt }),
        ...(props.lastUsedAt === undefined ? {} : { lastUsedAt: props.lastUsedAt }),
        ...(props.revokedAt === undefined ? {} : { revokedAt: props.revokedAt }),
        ...(props.supersededAt === undefined ? {} : { supersededAt: props.supersededAt }),
        createdAt: props.createdAt ?? new Date(),
      },
      id,
    )
  }

  static issue(props: {
    tenantId: string
    issuedBy: string
    name: string
    token: ApiKeyToken
    secretHash: string
    scopes: ApiKeyScopes
    expiresAt?: Date
    now: Date
  }): ApiKey {
    return ApiKey.create(
      {
        tenantId: props.tenantId,
        issuedBy: props.issuedBy,
        name: props.name,
        environment: props.token.environment,
        prefix: props.token.prefix,
        secretHash: props.secretHash,
        scopes: props.scopes,
        ...(props.expiresAt === undefined ? {} : { expiresAt: props.expiresAt }),
        createdAt: props.now,
      },
      new UniqueEntityID(),
    )
  }

  // --- questions -------------------------------------------------------------

  /**
   * Usable right now? Revocation, expiry and the end of a rotation overlap all land
   * here, so no caller has to remember the third one.
   */
  isUsableAt(now: Date): boolean {
    if (this.props.status !== 'active') return false
    if (this.props.expiresAt !== undefined && this.props.expiresAt <= now) return false
    if (this.props.supersededAt !== undefined && this.props.supersededAt <= now) return false
    return true
  }

  verifySecret(secret: string, hasher: PasswordHasher): Promise<boolean> {
    return hasher.verify(this.props.secretHash, secret)
  }

  permits(scope: string): boolean {
    return this.props.scopes.contains(scope)
  }

  /** Copy of the scopes, for re-checking against the issuer's *current* roles on use. */
  grantedScopes(): ApiKeyScopes {
    return this.props.scopes
  }

  issuer(): string {
    return this.props.issuedBy
  }

  /** Skip the write when the recorded value is already accurate to the minute. */
  shouldRecordUse(now: Date): boolean {
    if (this.props.lastUsedAt === undefined) return true
    return now.getTime() - this.props.lastUsedAt.getTime() >= ApiKey.LAST_USED_THROTTLE_MS
  }

  // --- behaviour -------------------------------------------------------------

  recordUse(now: Date): void {
    this.props.lastUsedAt = now
  }

  revoke(now: Date): Either<ConflictError, void> {
    if (this.props.status === 'revoked') return left(new ConflictError('key is already revoked'))

    this.props.status = 'revoked'
    this.props.revokedAt = now
    this.addDomainEvent(
      new ApiKeyRevokedEvent(this.id, this.props.tenantId, this.props.prefix, now),
    )
    return right(undefined)
  }

  /**
   * Produce this key's replacement, and mark this one as superseded at `until`.
   *
   * The aggregate makes its own successor rather than a use case assembling one from
   * fields read off it — which is what keeps the name, the scopes, the issuer and the
   * tenant travelling together instead of being copied across correctly four times.
   *
   * The overlap is the entire reason rotation is not just "revoke and issue": an
   * integration that cannot be redeployed atomically needs a window in which both
   * credentials authenticate.
   */
  rotate(props: {
    token: ApiKeyToken
    secretHash: string
    until: Date
    now: Date
  }): Either<ConflictError, ApiKey> {
    if (this.props.status === 'revoked')
      return left(new ConflictError('a revoked key cannot be rotated'))
    if (props.until <= props.now)
      return left(new ConflictError('the rotation overlap must end in the future'))

    this.props.supersededAt = props.until

    return right(
      ApiKey.issue({
        tenantId: this.props.tenantId,
        issuedBy: this.props.issuedBy,
        name: this.props.name,
        token: props.token,
        secretHash: props.secretHash,
        scopes: this.props.scopes,
        now: props.now,
      }),
    )
  }

  rename(name: string): void {
    this.props.name = name
  }

  toSnapshot(): Readonly<ApiKeySnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      issuedBy: this.props.issuedBy,
      name: this.props.name,
      environment: this.props.environment,
      prefix: this.props.prefix,
      secretHash: this.props.secretHash,
      scopes: this.props.scopes.values,
      status: this.props.status,
      expiresAt: this.props.expiresAt ?? null,
      lastUsedAt: this.props.lastUsedAt ?? null,
      revokedAt: this.props.revokedAt ?? null,
      supersededAt: this.props.supersededAt ?? null,
      createdAt: this.props.createdAt,
    })
  }
}
