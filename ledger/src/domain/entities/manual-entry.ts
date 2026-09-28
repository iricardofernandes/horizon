import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { SegregationOfDutiesError } from '@/core/errors/errors/segregation-of-duties-error'
import { type ApprovalAuthority, checkDuties } from '../controls/approval-delegation'
import type { Reason } from '../value-objects/ledger-values'
import type { EntrySide } from './ledger-account'

export const MANUAL_ENTRY_STATUSES = ['pending', 'approved', 'rejected'] as const
export type ManualEntryStatus = (typeof MANUAL_ENTRY_STATUSES)[number]

/** A line as it was written: checked when written, and checked again when it posts. */
export interface ManualEntryLine {
  readonly accountId: string
  readonly side: EntrySide
  readonly amount: string
  readonly memo: string | null
}

/** What the entry will post, exactly as the person wrote it. */
export interface ManualEntryTerms {
  readonly reference: string
  readonly postedOn: string
  readonly currency: string
  readonly memo: string | null
  readonly lines: readonly ManualEntryLine[]
}

interface ManualEntryProps {
  tenantId: string
  terms: ManualEntryTerms
  total: bigint
  status: ManualEntryStatus
  requestedBy: string
  requestedAt: Date
  decidedBy: string | null
  /** The approver who lent the decision, when it was taken through a delegation. */
  decidedFor: string | null
  decidedAt: Date | null
  decisionReason: string | null
  transactionId: string | null
  updatedAt: Date
}

export interface ManualEntrySnapshot {
  readonly id: string
  readonly tenantId: string
  readonly terms: ManualEntryTerms
  readonly total: bigint
  readonly status: ManualEntryStatus
  readonly requestedBy: string
  readonly requestedAt: Date
  readonly decidedBy: string | null
  readonly decidedFor: string | null
  readonly decidedAt: Date | null
  readonly decisionReason: string | null
  readonly transactionId: string | null
  readonly updatedAt: Date
}

/**
 * A manual journal entry at or above the workspace's threshold, waiting for a second person
 * (ADR 0062, Phase 68).
 *
 * It is not in the journal until approved, so no balance or report sees it. Approving posts
 * the transaction it describes — into a month that must still be open then — and whoever
 * wrote it can never decide it, in person or through a delegation they lent.
 */
export class ManualEntry extends AggregateRoot<ManualEntryProps> {
  static request(
    props: {
      tenantId: string
      terms: ManualEntryTerms
      total: bigint
      requestedBy: string
      now: Date
    },
    id?: UniqueEntityID,
  ): ManualEntry {
    return new ManualEntry(
      {
        tenantId: props.tenantId,
        terms: props.terms,
        total: props.total,
        status: 'pending',
        requestedBy: props.requestedBy,
        requestedAt: props.now,
        decidedBy: null,
        decidedFor: null,
        decidedAt: null,
        decisionReason: null,
        transactionId: null,
        updatedAt: props.now,
      },
      id,
    )
  }

  static rehydrate(props: ManualEntryProps, id: UniqueEntityID): ManualEntry {
    return new ManualEntry(props, id)
  }

  approve(
    authority: ApprovalAuthority,
    transactionId: string,
    now: Date,
  ): Either<ConflictError | SegregationOfDutiesError, void> {
    const decidable = this.decidable(authority)
    if (decidable.isLeft()) return decidable
    this.props.status = 'approved'
    this.props.transactionId = transactionId
    this.decided(authority, null, now)
    return right(undefined)
  }

  reject(
    authority: ApprovalAuthority,
    reason: Reason,
    now: Date,
  ): Either<ConflictError | SegregationOfDutiesError, void> {
    const decidable = this.decidable(authority)
    if (decidable.isLeft()) return decidable
    this.props.status = 'rejected'
    this.decided(authority, reason.value, now)
    return right(undefined)
  }

  get terms(): ManualEntryTerms {
    return this.props.terms
  }

  get total(): bigint {
    return this.props.total
  }

  get status(): ManualEntryStatus {
    return this.props.status
  }

  get requestedBy(): string {
    return this.props.requestedBy
  }

  toSnapshot(): Readonly<ManualEntrySnapshot> {
    return Object.freeze({ id: this.id.toString(), ...this.props })
  }

  private decided(authority: ApprovalAuthority, reason: string | null, now: Date): void {
    this.props.decidedBy = authority.actor
    this.props.decidedFor = authority.onBehalfOf
    this.props.decidedAt = now
    this.props.decisionReason = reason
    this.props.updatedAt = now
  }

  private decidable(
    authority: ApprovalAuthority,
  ): Either<ConflictError | SegregationOfDutiesError, void> {
    if (this.props.status !== 'pending')
      return left(new ConflictError('this manual entry is not waiting for a decision'))
    return checkDuties(
      'ledger.entry',
      [this.props.requestedBy],
      authority,
      'the person who wrote a manual entry cannot decide it',
    )
  }
}
