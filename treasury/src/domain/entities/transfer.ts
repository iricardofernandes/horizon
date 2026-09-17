import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { moneyPayload, TreasuryEvent } from '../events/treasury-events'
import type { BusinessDate, Memo, Money, Reason } from '../value-objects/treasury-values'
import type { Account } from './account'
import { JournalEntry } from './journal-entry'

export const TRANSFER_STATUSES = ['posted', 'cancelled'] as const
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
  postedAt: Date
  cancellation: { readonly at: Date; readonly reason: Reason } | null
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
  readonly postedAt: Date
  readonly cancelledAt: Date | null
  readonly cancellationReason: string | null
}

/**
 * Money moving between two accounts of the same workspace. The transfer and its legs — an
 * outflow, an inflow and, when there is one, a fee outflow — are produced together and
 * persisted in one transaction, so a transfer can never exist with only one leg.
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
        status: 'posted',
        postedAt: props.now,
        cancellation: null,
      },
      id,
    )
    const legs = transfer.legs(props.now)
    if (legs.isLeft()) return left(legs.value)
    transfer.addDomainEvent(
      new TreasuryEvent('treasury.transfer.posted', transfer.id, props.tenantId, props.now, {
        transferId: transfer.id.toString(),
        fromAccountId: transfer.props.fromAccountId,
        toAccountId: transfer.props.toAccountId,
        amount: moneyPayload(props.amount),
        fee: fee ? moneyPayload(fee) : null,
        valueOn: props.valueOn.value,
        postedAt: props.now.toISOString(),
      }),
    )
    return right({ transfer, legs: legs.value })
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
    if (this.props.status !== 'posted')
      return left(new ConflictError('the transfer is already cancelled'))
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
      postedAt: this.props.postedAt,
      cancelledAt: this.props.cancellation?.at ?? null,
      cancellationReason: this.props.cancellation?.reason.value ?? null,
    })
  }
}
