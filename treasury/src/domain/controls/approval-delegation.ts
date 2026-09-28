import { type Either, left, right } from '@/core/either'
import { Entity } from '@/core/entities/entity'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { SegregationOfDutiesError } from '@/core/errors/errors/segregation-of-duties-error'

/** A longer absence is a role change, not a delegation (ADR 0062). */
export const DELEGATION_MAX_DAYS = 90
const DAY_MS = 86_400_000

export const DELEGATION_STATES = ['scheduled', 'active', 'ended', 'revoked'] as const
export type DelegationState = (typeof DELEGATION_STATES)[number]

/**
 * Who decides, and for whom. `onBehalfOf` is the approver who lent the approval, when the
 * person deciding holds it only through a delegation; both names are recorded.
 */
export interface ApprovalAuthority {
  readonly actor: string
  readonly onBehalfOf: string | null
  readonly delegationId: string | null
}

export function ownAuthority(actor: string): ApprovalAuthority {
  return { actor, onBehalfOf: null, delegationId: null }
}

/**
 * Refuse a decision when anyone deciding, in person or through a delegation, did the work
 * being decided (ADR 0062). `performers` are the actors the record already keeps.
 */
export function checkDuties(
  pair: string,
  performers: readonly (string | null)[],
  authority: ApprovalAuthority,
  detail: string,
): Either<SegregationOfDutiesError, void> {
  const done = new Set(performers.filter((actor): actor is string => actor !== null))
  if (done.has(authority.actor)) return left(new SegregationOfDutiesError(pair, detail))
  if (authority.onBehalfOf !== null && done.has(authority.onBehalfOf))
    return left(
      new SegregationOfDutiesError(
        pair,
        `${detail}, even through a delegation from the person who did it`,
      ),
    )
  return right(undefined)
}

interface ApprovalDelegationProps {
  tenantId: string
  permission: string
  delegatorId: string
  delegateId: string
  startsAt: Date
  endsAt: Date
  reason: string | null
  createdAt: Date
  revokedAt: Date | null
  revokedBy: string | null
}

export interface ApprovalDelegationSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly permission: string
  readonly delegatorId: string
  readonly delegateId: string
  readonly startsAt: Date
  readonly endsAt: Date
  readonly reason: string | null
  readonly createdAt: Date
  readonly revokedAt: Date | null
  readonly revokedBy: string | null
}

/**
 * An approver lends one approval to a colleague for a period, typically an absence.
 *
 * The delegate needs a role in the module, which their own token proves each time they use
 * it; the delegation lends the approval and nothing else. It cannot be passed on: granting
 * one takes the approval through a role, never through another delegation.
 */
export class ApprovalDelegation extends Entity<ApprovalDelegationProps> {
  static grant(
    props: {
      tenantId: string
      permission: string
      delegable: readonly string[]
      delegatorId: string
      delegateId: string
      startsAt: Date
      endsAt: Date
      reason: string | null
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<InvalidInputError, ApprovalDelegation> {
    if (!props.delegable.includes(props.permission))
      return left(new InvalidInputError('/permission', 'is not an approval this module lends'))
    if (props.delegateId === props.delegatorId)
      return left(new InvalidInputError('/delegateId', 'must be someone else'))
    if (props.endsAt <= props.startsAt)
      return left(new InvalidInputError('/endsAt', 'must be after the start'))
    if (props.endsAt <= props.now)
      return left(new InvalidInputError('/endsAt', 'must be in the future'))
    if (props.endsAt.getTime() - props.startsAt.getTime() > DELEGATION_MAX_DAYS * DAY_MS)
      return left(
        new InvalidInputError('/endsAt', `a delegation lasts at most ${DELEGATION_MAX_DAYS} days`),
      )
    return right(
      new ApprovalDelegation(
        {
          tenantId: props.tenantId,
          permission: props.permission,
          delegatorId: props.delegatorId,
          delegateId: props.delegateId,
          startsAt: props.startsAt,
          endsAt: props.endsAt,
          reason: props.reason,
          createdAt: props.now,
          revokedAt: null,
          revokedBy: null,
        },
        id,
      ),
    )
  }

  static rehydrate(props: ApprovalDelegationProps, id: UniqueEntityID): ApprovalDelegation {
    return new ApprovalDelegation(props, id)
  }

  /** The delegator, or anyone holding the approval through a role, may end it early. */
  revoke(actor: string, now: Date): Either<ConflictError, void> {
    const state = this.stateAt(now)
    if (state === 'revoked' || state === 'ended')
      return left(new ConflictError(`this delegation has already ${state}`))
    this.props.revokedAt = now
    this.props.revokedBy = actor
    return right(undefined)
  }

  stateAt(now: Date): DelegationState {
    if (this.props.revokedAt) return 'revoked'
    if (now >= this.props.endsAt) return 'ended'
    if (now < this.props.startsAt) return 'scheduled'
    return 'active'
  }

  authorityFor(delegateId: string, permission: string, now: Date): ApprovalAuthority | null {
    if (delegateId !== this.props.delegateId || permission !== this.props.permission) return null
    if (this.stateAt(now) !== 'active') return null
    return {
      actor: delegateId,
      onBehalfOf: this.props.delegatorId,
      delegationId: this.id.toString(),
    }
  }

  get delegatorId(): string {
    return this.props.delegatorId
  }

  get delegateId(): string {
    return this.props.delegateId
  }

  get permission(): string {
    return this.props.permission
  }

  toSnapshot(): Readonly<ApprovalDelegationSnapshot> {
    return Object.freeze({ id: this.id.toString(), ...this.props })
  }
}
