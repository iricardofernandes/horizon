import { Entity } from '@/core/entities/entity'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { PasswordHasher } from '@/domain/services/password-hasher'
import type { Locale } from '@/domain/value-objects/locale'
import type { Argon2Policy, PasswordHash } from '@/domain/value-objects/password-hash'

export type AccountStatus = 'active' | 'disabled'

interface AccountProps {
  passwordHash: PasswordHash
  status: AccountStatus
  preferredLocale?: Locale
  lastLoginAt?: Date
  readonly createdAt: Date
  updatedAt: Date
}

/**
 * A global login identity. Tenant-specific identity, roles and lifecycle remain on User,
 * which now represents one workspace membership. Keeping the credential here is what
 * lets one email/password unlock several memberships without weakening tenant RLS.
 */
export class Account extends Entity<AccountProps> {
  static create(
    props: {
      passwordHash: PasswordHash
      status?: AccountStatus
      preferredLocale?: Locale
      lastLoginAt?: Date
      createdAt?: Date
      updatedAt?: Date
    },
    id?: UniqueEntityID,
  ): Account {
    const now = props.createdAt ?? new Date()
    return new Account(
      {
        passwordHash: props.passwordHash,
        status: props.status ?? 'active',
        ...(props.preferredLocale === undefined ? {} : { preferredLocale: props.preferredLocale }),
        ...(props.lastLoginAt === undefined ? {} : { lastLoginAt: props.lastLoginAt }),
        createdAt: now,
        updatedAt: props.updatedAt ?? now,
      },
      id,
    )
  }

  verifyPassword(plaintext: string, hasher: PasswordHasher): Promise<boolean> {
    return hasher.verify(this.props.passwordHash.encoded, plaintext)
  }

  canAuthenticate(): boolean {
    return this.props.status === 'active'
  }

  needsRehash(policy: Argon2Policy): boolean {
    return this.props.passwordHash.needsRehash(policy)
  }

  recordSuccessfulLogin(now: Date): void {
    this.props.lastLoginAt = now
    this.props.updatedAt = now
  }

  upgradePasswordHash(hash: PasswordHash, now: Date): void {
    this.props.passwordHash = hash
    this.props.updatedAt = now
  }

  /** The language this person reads in, in every workspace they belong to. */
  choosePreferredLocale(locale: Locale, now: Date): void {
    this.props.preferredLocale = locale
    this.props.updatedAt = now
  }

  toSnapshot(): Readonly<{
    id: string
    passwordHash: string
    status: AccountStatus
    preferredLocale: string | null
    lastLoginAt: Date | null
    createdAt: Date
    updatedAt: Date
  }> {
    return Object.freeze({
      id: this.id.toString(),
      passwordHash: this.props.passwordHash.encoded,
      status: this.props.status,
      preferredLocale: this.props.preferredLocale?.value ?? null,
      lastLoginAt: this.props.lastLoginAt ?? null,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
