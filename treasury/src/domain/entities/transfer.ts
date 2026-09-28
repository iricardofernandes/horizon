import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { SegregationOfDutiesError } from '@/core/errors/errors/segregation-of-duties-error'
import { type ApprovalAuthority, checkDuties } from '../controls/approval-delegation'
import { moneyPayload, TreasuryEvent } from '../events/treasury-events'
import type { BusinessDate, Memo, Money, Reason } from '../value-objects/treasury-values'
import type { Account } from './account'
import { JournalEntry } from './journal-entry'

export const TRANSFER_STATUSES = ['pending', 'posted', 'rejected', 'cancelled'] as const
export type TransferStatus = (typeof TRANSFER_STATUSES)[number]

interface TransferProps {
  tenantId: string
  fromAccountId: string
  toAccountId: string
  amount: Money
  fee: Money | null
  valueOn: BusinessDate
  memo: Memo | null
  status: TransferStatus
  /** Who asked for it: one side of the transfer pair (ADR 0062). Unknown for older ones. */
  requestedBy: string | null
  requestedAt: Date
  /** When its legs were written: at once, or when a second person approved it. */
  postedAt: Date | null
  decision: TransferDecision | null
  cancellation: { readonly at: Date; readonly reason: Reason } | null
}

export interface TransferDecision {
  readonly by: string
  /** The approver who lent the decision, when it was taken through a delegation. */
  readonly for: string | null
  readonly at: Date
  readonly reason: Reason | null
}

export interface TransferSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly fromAccountId: string
  readonly toAccountId: string
  readonly amount: string
  readonly fee: string | null
  readonly currency: string
  readonly valueOn: string
  readonly memo: string | null
  readonly status: TransferStatus
  readonly requestedBy: string | null
  readonly requestedAt: Date
  readonly postedAt: Date | null
  readonly decidedBy: string | null
  readonly decidedFor: string | null
  readonly decidedAt: Date | null
  readonly decisionReason: string | null
  readonly cancelledAt: Date | null
  readonly cancellationReason: string | null
}

/**
 * Money moving between two accounts of the same workspace. The transfer and its legs — an
 * outflow, an inflow and, when there is one, a fee outflow — are produced together and
 * persisted in one transaction, so a transfer can never exist with only one leg.
 *
 * At or above the workspace's threshold a transfer waits for a second person, with no legs
 * and nothing announced, and whoever asked for it can never decide it (ADR 0062).
 */
export class Transfer extends AggregateRoot<TransferProps> {
  static post(
    props: {
      tenantId: string
      from: Account
      to: Account
      amount: Money
      fee: Money | null
      valueOn: BusinessDate
      memo: Memo | null
      now: Date
      requestedBy?: string | null
      approvalRequired?: boolean
    },
    id?: UniqueEntityID,
  ): Either<InvalidInputError | ConflictError, { transfer: Transfer; legs: JournalEntry[] }> {
    if (props.from.id.equals(props.to.id))
      return left(new InvalidInputError('/toAccountId', 'must differ from the source account'))
    if (props.amount.isZero())
      return left(new InvalidInputError('/amount', 'must be greater than zero'))
    for (const account of [props.from, props.to]) {
      const accepted = account.accepts(props.amount.currency, props.valueOn)
      if (accepted.isLeft()) return left(accepted.value)
    }
    const fee = props.fee && !props.fee.isZero() ? props.fee : null
    if (fee && !fee.currency.equals(props.amount.currency))
      return left(new InvalidInputError('/fee', 'must be in the transfer currency'))
    const transfer = new Transfer(
      {
        tenantId: props.tenantId,
        fromAccountId: props.from.id.toString(),
        toAccountId: props.to.id.toString(),
        amount: props.amount,
        fee,
        valueOn: props.valueOn,
        memo: props.memo,
        status: props.approvalRequired ? 'pending' : 'posted',
        requestedBy: props.requestedBy ?? null,
        requestedAt: props.now,
        postedAt: props.approvalRequired ? null : props.now,
        decision: null,
        cancellation: null,
      },
      id,
    )
    if (props.approvalRequired) return right({ transfer, legs: [] })
    const legs = transfer.written(props.now)
    if (legs.isLeft()) return left(legs.value)
    return right({ transfer, legs: legs.value })
  }

  /**
   * A second person lets it go. The accounts are checked again — either may have closed
   * while it waited — and the legs are written and announced now.
   */
  approve(
    authority: ApprovalAuthority,
    accounts: { readonly from: Account; readonly to: Account },
    now: Date,
  ): Either<ConflictError | SegregationOfDutiesError | InvalidInputError, JournalEntry[]> {
    const decidable = this.decidable(authority)
    if (decidable.isLeft()) return left(decidable.value)
    for (const account of [accounts.from, accounts.to]) {
      const accepted = account.accepts(this.props.amount.currency, this.props.valueOn)
      if (accepted.isLeft()) return left(accepted.value)
    }
    const legs = this.written(now)
    if (legs.isLeft()) return left(legs.value)
    this.props.status = 'posted'
    this.props.postedAt = now
    this.props.decision = { by: authority.actor, for: authority.onBehalfOf, at: now, reason: null }
    return right(legs.value)
  }

  reject(
    authority: ApprovalAuthority,
    reason: Reason,
    now: Date,
  ): Either<ConflictError | SegregationOfDutiesError, void> {
    const decidable = this.decidable(authority)
    if (decidable.isLeft()) return decidable
    this.props.status = 'rejected'
    this.props.decision = { by: authority.actor, for: authority.onBehalfOf, at: now, reason }
    return right(undefined)
  }

  get status(): TransferStatus {
    return this.props.status
  }

  get amount(): Money {
    return this.props.amount
  }

  private decidable(
    authority: ApprovalAuthority,
  ): Either<ConflictError | SegregationOfDutiesError, void> {
    if (this.props.status !== 'pending')
      return left(new ConflictError('this transfer is not waiting for a decision'))
    return checkDuties(
      'treasury.transfer',
      [this.props.requestedBy],
      authority,
      'the person who asked for a transfer cannot decide it',
    )
  }

  /** Its legs, and the announcement that it moved money. */
  private written(now: Date): Either<InvalidInputError, JournalEntry[]> {
    const legs = this.legs(now)
    if (legs.isLeft()) return left(legs.value)
    this.addDomainEvent(
      new TreasuryEvent('treasury.transfer.posted', this.id, this.props.tenantId, now, {
        transferId: this.id.toString(),
        fromAccountId: this.props.fromAccountId,
        toAccountId: this.props.toAccountId,
        amount: moneyPayload(this.props.amount),
        fee: this.props.fee ? moneyPayload(this.props.fee) : null,
        valueOn: this.props.valueOn.value,
        postedAt: now.toISOString(),
      }),
    )
    return right(legs.value)
  }

  static rehydrate(props: TransferProps, id: UniqueEntityID): Transfer {
    return new Transfer(props, id)
  }

  get fromAccountId(): string {
    return this.props.fromAccountId
  }

  get toAccountId(): string {
    return this.props.toAccountId
  }

  /**
   * Undo the transfer with inverse entries for every leg, dated as the transfer was, so the
   * accounts show they were never moved. The original legs stay in the journal.
   */
  cancel(
    legs: readonly JournalEntry[],
    reason: Reason,
    now: Date,
  ): Either<ConflictError | InvalidInputError, JournalEntry[]> {
    if (this.props.status === 'pending')
      return left(new ConflictError('a transfer waiting for approval is rejected, not cancelled'))
    if (this.props.status !== 'posted')
      return left(new ConflictError(`the transfer is already ${this.props.status}`))
    const inverses: JournalEntry[] = []
    for (const leg of legs) {
      const inverse = leg.reverse(reason, now, { fromTransfer: true })
      if (inverse.isLeft()) return left(inverse.value)
      inverses.push(inverse.value)
    }
    this.props.status = 'cancelled'
    this.props.cancellation = { at: now, reason }
    this.addDomainEvent(
      new TreasuryEvent('treasury.transfer.cancelled', this.id, this.props.tenantId, now, {
        transferId: this.id.toString(),
        cancelledAt: now.toISOString(),
        reason: reason.value,
      }),
    )
    return right(inverses)
  }

  private legs(now: Date): Either<InvalidInputError, JournalEntry[]> {
    const common = {
      tenantId: this.props.tenantId,
      valueOn: this.props.valueOn,
      transferId: this.id.toString(),
      settlementId: null,
      reverses: null,
      counterparty: null,
      memo: this.props.memo,
      reason: null,
      now,
    }
    const rows = [
      {
        accountId: this.props.fromAccountId,
        direction: 'outflow' as const,
        amount: this.props.amount,
        source: 'transfer' as const,
      },
      {
        accountId: this.props.toAccountId,
        direction: 'inflow' as const,
        amount: this.props.amount,
        source: 'transfer' as const,
      },
      ...(this.props.fee
        ? [
            {
              accountId: this.props.fromAccountId,
              direction: 'outflow' as const,
              amount: this.props.fee,
              source: 'transfer-fee' as const,
            },
          ]
        : []),
    ]
    const legs: JournalEntry[] = []
    for (const row of rows) {
      const leg = JournalEntry.record({ ...common, ...row })
      if (leg.isLeft()) return left(leg.value)
      legs.push(leg.value)
    }
    return right(legs)
  }

  toSnapshot(): Readonly<TransferSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      fromAccountId: this.props.fromAccountId,
      toAccountId: this.props.toAccountId,
      amount: this.props.amount.amount.toString(),
      fee: this.props.fee?.amount.toString() ?? null,
      currency: this.props.amount.currency.value,
      valueOn: this.props.valueOn.value,
      memo: this.props.memo?.value ?? null,
      status: this.props.status,
      requestedBy: this.props.requestedBy,
      requestedAt: this.props.requestedAt,
      postedAt: this.props.postedAt,
      decidedBy: this.props.decision?.by ?? null,
      decidedFor: this.props.decision?.for ?? null,
      decidedAt: this.props.decision?.at ?? null,
      decisionReason: this.props.decision?.reason?.value ?? null,
      cancelledAt: this.props.cancellation?.at ?? null,
      cancellationReason: this.props.cancellation?.reason.value ?? null,
    })
  }
}
