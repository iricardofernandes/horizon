import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { SessionReuseDetectedEvent } from '@/domain/events/session-reuse-detected-event'

export const FAMILY_END_REASONS = ['logout', 'reuse-detected', 'user-disabled', 'expired'] as const
export type FamilyEndReason = (typeof FAMILY_END_REASONS)[number]

/** Both lifetimes, from configuration (ADR 0020). */
export interface SessionLifetimes {
  readonly absoluteTtlSeconds: number
  readonly idleTtlSeconds: number
  readonly reuseGraceMs: number
}

interface RefreshTokenFamilyProps {
  readonly tenantId: string
  readonly userId: string
  currentDigest: string
  previousDigest?: string
  /** The replacement issued for `previousDigest`, sealed under that token (ADR 0020). */
  graceSealed?: string
  previousRotatedAt?: Date
  status: 'active' | 'ended'
  endedReason?: FamilyEndReason
  readonly createdAt: Date
  lastUsedAt: Date
}

export interface RefreshTokenFamilySnapshot {
  readonly id: string
  readonly tenantId: string
  readonly userId: string
  readonly currentDigest: string
  readonly previousDigest: string | null
  readonly graceSealed: string | null
  readonly previousRotatedAt: Date | null
  readonly status: 'active' | 'ended'
  readonly endedReason: FamilyEndReason | null
  readonly createdAt: Date
  readonly lastUsedAt: Date
}

/**
 * One device's session: a chain of refresh tokens, only the newest of which is live.
 *
 * The design question is not how to make theft impossible but how to make it
 * **detectable** (ADR 0020). Presenting an already-rotated token means two parties hold
 * tokens from one family, so one of them is an attacker — and the response is to kill the
 * family, logging out both. A forced re-login is a far better outcome than an undetected
 * persistent session.
 *
 * Only digests live here. The tokens themselves are 256 bits of randomness that exist in
 * exactly two places: the client, and the HTTP response that delivered them.
 */
export class RefreshTokenFamily extends AggregateRoot<RefreshTokenFamilyProps> {
  static create(
    props: {
      tenantId: string
      userId: string
      currentDigest: string
      previousDigest?: string
      graceSealed?: string
      previousRotatedAt?: Date
      status?: 'active' | 'ended'
      endedReason?: FamilyEndReason
      createdAt?: Date
      lastUsedAt?: Date
    },
    id?: UniqueEntityID,
  ): RefreshTokenFamily {
    const now = props.createdAt ?? new Date()
    return new RefreshTokenFamily(
      {
        tenantId: props.tenantId,
        userId: props.userId,
        currentDigest: props.currentDigest,
        ...(props.previousDigest === undefined ? {} : { previousDigest: props.previousDigest }),
        ...(props.graceSealed === undefined ? {} : { graceSealed: props.graceSealed }),
        ...(props.previousRotatedAt === undefined
          ? {}
          : { previousRotatedAt: props.previousRotatedAt }),
        status: props.status ?? 'active',
        ...(props.endedReason === undefined ? {} : { endedReason: props.endedReason }),
        createdAt: now,
        lastUsedAt: props.lastUsedAt ?? now,
      },
      id,
    )
  }

  /** A family is created at login and represents one device's session. */
  static open(props: {
    tenantId: string
    userId: string
    currentDigest: string
    now: Date
  }): RefreshTokenFamily {
    return RefreshTokenFamily.create(
      {
        tenantId: props.tenantId,
        userId: props.userId,
        currentDigest: props.currentDigest,
        createdAt: props.now,
      },
      new UniqueEntityID(),
    )
  }

  // --- questions -------------------------------------------------------------

  isActive(): boolean {
    return this.props.status === 'active'
  }

  userId(): string {
    return this.props.userId
  }

  /**
   * Two independent lifetimes, and both must hold: an absolute maximum from family
   * creation regardless of use, and an idle timeout since last use. The first bounds how
   * long a stolen device stays useful; the second bounds an abandoned session.
   */
  isExpiredAt(now: Date, lifetimes: SessionLifetimes): boolean {
    const sinceCreation = now.getTime() - this.props.createdAt.getTime()
    const sinceUse = now.getTime() - this.props.lastUsedAt.getTime()
    return (
      sinceCreation >= lifetimes.absoluteTtlSeconds * 1000 ||
      sinceUse >= lifetimes.idleTtlSeconds * 1000
    )
  }

  /**
   * Seconds left on the absolute lifetime.
   *
   * The store's TTL shrinks as the family ages rather than being renewed on each
   * rotation — otherwise refreshing would extend the absolute deadline, and there would
   * be only one lifetime instead of the two ADR 0020 requires.
   */
  remainingAbsoluteSeconds(now: Date, absoluteTtlSeconds: number): number {
    const deadline = this.props.createdAt.getTime() + absoluteTtlSeconds * 1000
    return Math.max(1, Math.ceil((deadline - now.getTime()) / 1000))
  }

  isCurrent(digest: string): boolean {
    return this.props.currentDigest === digest
  }

  /**
   * The sealed replacement for a token presented inside the grace window, or `null`.
   *
   * A `null` here for a digest that is nonetheless the previous token is the reuse
   * signal: the window closed, so this is a replay rather than a race.
   */
  graceReplacementFor(digest: string, now: Date, graceMs: number): string | null {
    if (this.props.previousDigest !== digest) return null
    if (this.props.previousRotatedAt === undefined) return null
    if (this.props.graceSealed === undefined) return null
    if (now.getTime() - this.props.previousRotatedAt.getTime() > graceMs) return null
    return this.props.graceSealed
  }

  wasRotatedFrom(digest: string): boolean {
    return this.props.previousDigest === digest
  }

  // --- behaviour -------------------------------------------------------------

  /**
   * Advance the chain. The token just used becomes the previous one, and the replacement
   * is sealed under it so a racing tab gets the same value back rather than tripping the
   * alarm.
   */
  rotateTo(props: {
    digest: string
    sealedReplacement: string
    now: Date
  }): Either<ConflictError, void> {
    if (this.props.status !== 'active')
      return left(new ConflictError('session family has already ended'))

    this.props.previousDigest = this.props.currentDigest
    this.props.previousRotatedAt = props.now
    this.props.graceSealed = props.sealedReplacement
    this.props.currentDigest = props.digest
    this.props.lastUsedAt = props.now
    return right(undefined)
  }

  /**
   * A rotated token was replayed outside the grace window. Kill the family and say so —
   * loudly, because this is the one event in the module worth waking someone for.
   */
  detectReuse(now: Date): void {
    this.props.status = 'ended'
    this.props.endedReason = 'reuse-detected'
    // Remove the sealed replacement entirely (exactOptionalPropertyTypes).
    delete this.props.graceSealed
    this.addDomainEvent(
      new SessionReuseDetectedEvent(this.id, this.props.tenantId, this.props.userId, now),
    )
  }

  end(reason: Exclude<FamilyEndReason, 'reuse-detected'>): void {
    this.props.status = 'ended'
    this.props.endedReason = reason
    delete this.props.graceSealed
  }

  toSnapshot(): Readonly<RefreshTokenFamilySnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      userId: this.props.userId,
      currentDigest: this.props.currentDigest,
      previousDigest: this.props.previousDigest ?? null,
      graceSealed: this.props.graceSealed ?? null,
      previousRotatedAt: this.props.previousRotatedAt ?? null,
      status: this.props.status,
      endedReason: this.props.endedReason ?? null,
      createdAt: this.props.createdAt,
      lastUsedAt: this.props.lastUsedAt,
    })
  }
}
