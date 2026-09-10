import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { UserDisabledEvent } from '@/domain/events/user-disabled-event'
import { UserRegisteredEvent } from '@/domain/events/user-registered-event'
import type { PasswordHasher } from '@/domain/services/password-hasher'
import type { ApiKeyScopes } from '@/domain/value-objects/api-key-scopes'
import type { Email } from '@/domain/value-objects/email'
import type { Argon2Policy, PasswordHash } from '@/domain/value-objects/password-hash'
import type { PersonName } from '@/domain/value-objects/person-name'
import { type RoleAssignment, RoleAssignments } from '@/domain/value-objects/role-assignments'

export const USER_STATUSES = ['active', 'disabled', 'erased'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

interface UserProps {
  readonly tenantId: string
  email: Email
  name: PersonName
  passwordHash: PasswordHash
  roles: RoleAssignments
  status: UserStatus
  lastLoginAt?: Date
  readonly createdAt: Date
  updatedAt: Date
}

/** The frozen struct mappers and presenters read. The only way out (ADR 0031). */
export interface UserSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly email: string
  readonly name: string
  readonly passwordHash: string
  readonly roles: readonly RoleAssignment[]
  readonly status: UserStatus
  readonly lastLoginAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** What a minted access token carries about its subject (ADR 0018). */
export interface UserClaims {
  readonly subject: string
  readonly tenantId: string
  readonly roles: readonly RoleAssignment[]
}

/**
 * Someone who logs in — which is not the same thing as a customer, and never becomes
 * one. A customer is a commercial counterparty with its own lifecycle and belongs to
 * `sales/`.
 *
 * There are no property accessors (ADR 0031 rule 5). Every question a caller can ask is
 * a method that answers it — `verifyPassword`, `needsRehash`, `canMint`, `claims` — so
 * the aggregate decides what the answer means rather than handing out its fields and
 * hoping. `toSnapshot()` is the one exception, is frozen, and is reachable only from
 * `infrastructure/` and `test/`, which the boundary script enforces.
 *
 * `email` and `name` are personal data: encrypted per data subject at rest, with the
 * email additionally carrying a blind index so login can find it by exact match and
 * nothing else (ADR 0026). That is a persistence concern and lives in the mapper; the
 * aggregate holds plaintext value objects, because a model reasoning about ciphertext
 * can enforce no invariant about it.
 */
export class User extends AggregateRoot<UserProps> {
  static create(
    props: {
      tenantId: string
      email: Email
      name: PersonName
      passwordHash: PasswordHash
      roles?: RoleAssignments
      status?: UserStatus
      lastLoginAt?: Date
      createdAt?: Date
      updatedAt?: Date
    },
    id?: UniqueEntityID,
  ): User {
    const now = props.createdAt ?? new Date()
    return new User(
      {
        tenantId: props.tenantId,
        email: props.email,
        name: props.name,
        passwordHash: props.passwordHash,
        roles: props.roles ?? RoleAssignments.empty(),
        status: props.status ?? 'active',
        ...(props.lastLoginAt === undefined ? {} : { lastLoginAt: props.lastLoginAt }),
        createdAt: now,
        updatedAt: props.updatedAt ?? now,
      },
      id,
    )
  }

  /** Construction plus the fact of it. The only path that emits `user.registered`. */
  static register(props: {
    tenantId: string
    email: Email
    name: PersonName
    passwordHash: PasswordHash
    roles: RoleAssignments
    now: Date
  }): User {
    const id = new UniqueEntityID()
    const user = User.create(
      {
        tenantId: props.tenantId,
        email: props.email,
        name: props.name,
        passwordHash: props.passwordHash,
        roles: props.roles,
        createdAt: props.now,
      },
      id,
    )
    user.addDomainEvent(new UserRegisteredEvent(id, props.tenantId, props.now))
    return user
  }

  // --- questions -------------------------------------------------------------

  /**
   * May this user authenticate at all?
   *
   * Asked *after* the password is verified, never before. Short-circuiting on a disabled
   * account skips the hash comparison, and the missing ~50 ms is a reliable signal that
   * the account exists — so the check is cheap and the ordering is the security property.
   */
  canAuthenticate(): boolean {
    return this.props.status === 'active'
  }

  isErased(): boolean {
    return this.props.status === 'erased'
  }

  verifyPassword(plaintext: string, hasher: PasswordHasher): Promise<boolean> {
    return hasher.verify(this.props.passwordHash.encoded, plaintext)
  }

  needsRehash(policy: Argon2Policy): boolean {
    return this.props.passwordHash.needsRehash(policy)
  }

  /** Could this user mint a key with these scopes? The ADR 0022 subset rule. */
  canMint(scopes: ApiKeyScopes): boolean {
    return scopes.isGrantableBy(this.props.roles)
  }

  /** The modules a key would reach that this user does not — so a refusal can say why. */
  scopesBeyondReach(scopes: ApiKeyScopes): readonly string[] {
    return scopes.modulesBeyond(this.props.roles)
  }

  holds(assignment: RoleAssignment): boolean {
    return this.props.roles.has(assignment.module, assignment.role)
  }

  /** The claim set an access token carries. Role *names*, never expanded (ADR 0023). */
  claims(): Readonly<UserClaims> {
    return Object.freeze({
      subject: this.id.toString(),
      tenantId: this.props.tenantId,
      roles: this.props.roles.pairs,
    })
  }

  // --- behaviour -------------------------------------------------------------

  recordSuccessfulLogin(now: Date): void {
    this.props.lastLoginAt = now
    this.props.updatedAt = now
  }

  /**
   * Replace a hash produced under a weaker policy (ADR 0019). Called inside the login
   * request that proved the password, which is the only moment the plaintext exists —
   * hence "transparently", and hence no migration.
   */
  upgradePasswordHash(hash: PasswordHash, now: Date): void {
    this.props.passwordHash = hash
    this.props.updatedAt = now
  }

  changePassword(hash: PasswordHash, now: Date): void {
    this.props.passwordHash = hash
    this.props.updatedAt = now
  }

  disable(now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'active')
      return left(new ConflictError(`user is ${this.props.status}, not active`))

    this.props.status = 'disabled'
    this.props.updatedAt = now
    this.addDomainEvent(new UserDisabledEvent(this.id, this.props.tenantId, now))
    return right(undefined)
  }

  reinstate(now: Date): Either<ConflictError, void> {
    if (this.props.status === 'erased')
      return left(new ConflictError('an erased user cannot be reinstated'))
    if (this.props.status === 'active') return left(new ConflictError('user is already active'))

    this.props.status = 'active'
    this.props.updatedAt = now
    return right(undefined)
  }

  /**
   * Mark the subject erased. The row survives and the ciphertext survives byte for byte;
   * what is destroyed — elsewhere in the same transaction — is the key that makes the
   * ciphertext mean anything (ADR 0026). That is precisely why the audit chain still
   * verifies afterwards.
   */
  markErased(now: Date): Either<ConflictError, void> {
    if (this.props.status === 'erased') return left(new ConflictError('user is already erased'))

    this.props.status = 'erased'
    // An erased subject grants nothing. Dropping the assignments here means a token
    // minted from a stale read cannot outlive the erasure by carrying old claims.
    this.props.roles = RoleAssignments.empty()
    this.props.updatedAt = now
    return right(undefined)
  }

  grant(assignment: RoleAssignment, now: Date): Either<ConflictError, void> {
    if (this.props.roles.has(assignment.module, assignment.role))
      return left(new ConflictError(`user already holds ${assignment.module}:${assignment.role}`))

    this.props.roles = this.props.roles.grant(assignment)
    this.props.updatedAt = now
    return right(undefined)
  }

  revokeRole(assignment: RoleAssignment, now: Date): Either<ConflictError, void> {
    if (!this.props.roles.has(assignment.module, assignment.role))
      return left(new ConflictError(`user does not hold ${assignment.module}:${assignment.role}`))

    this.props.roles = this.props.roles.revoke(assignment)
    this.props.updatedAt = now
    return right(undefined)
  }

  toSnapshot(): Readonly<UserSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      email: this.props.email.value,
      name: this.props.name.value,
      passwordHash: this.props.passwordHash.encoded,
      roles: this.props.roles.pairs,
      status: this.props.status,
      lastLoginAt: this.props.lastLoginAt ?? null,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
