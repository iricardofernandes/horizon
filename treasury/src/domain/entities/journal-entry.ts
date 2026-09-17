import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { moneyPayload, TreasuryEvent } from '../events/treasury-events'
import type { BusinessDate, Memo, Money, Reason } from '../value-objects/treasury-values'

export const ENTRY_DIRECTIONS = ['inflow', 'outflow'] as const
export type EntryDirection = (typeof ENTRY_DIRECTIONS)[number]

export const ENTRY_SOURCES = ['opening', 'manual', 'transfer', 'transfer-fee', 'reversal'] as const
export type EntrySource = (typeof ENTRY_SOURCES)[number]

interface EntryProps {
  tenantId: string
  accountId: string
  direction: EntryDirection
  amount: Money
  valueOn: BusinessDate
  source: EntrySource
  transferId: string | null
  reverses: string | null
  counterparty: Memo | null
  memo: Memo | null
  /** Why a reversal was recorded; null on every other entry. */
  reason: Reason | null
  recordedAt: Date
}

export interface EntrySnapshot {
  readonly id: string
  readonly tenantId: string
  readonly accountId: string
  readonly direction: EntryDirection
  readonly amount: string
  readonly currency: string
  readonly valueOn: string
  readonly source: EntrySource
  readonly transferId: string | null
  readonly reverses: string | null
  readonly counterparty: string | null
  readonly memo: string | null
  readonly reason: string | null
  readonly recordedAt: Date
}

/**
 * One line of an account journal. Amounts are never negative; the direction says whether
 * money came in or went out. An entry is never edited or deleted: a correction is a new
 * entry in the opposite direction naming the one it reverses (ADR 0042).
 *
 * `valueOn` is when the money moved, which may be earlier than when it was recorded. Every
 * balance is computed from the journal by value date, so a backdated entry changes past
 * balances deterministically without rewriting anything.
 */
export class JournalEntry extends AggregateRoot<EntryProps> {
  static record(
    props: Omit<EntryProps, 'recordedAt'> & { now: Date },
    id?: UniqueEntityID,
  ): Either<InvalidInputError, JournalEntry> {
    if (props.amount.isZero())
      return left(new InvalidInputError('/amount', 'must be greater than zero'))
    const { now, ...rest } = props
    const entry = new JournalEntry({ ...rest, recordedAt: now }, id)
    entry.addDomainEvent(
      new TreasuryEvent('treasury.entry.recorded', entry.id, props.tenantId, now, {
        entryId: entry.id.toString(),
        accountId: props.accountId,
        direction: props.direction,
        amount: moneyPayload(props.amount),
        valueOn: props.valueOn.value,
        source: {
          type: props.source,
          id: props.transferId ?? props.reverses,
        },
        reverses: props.reverses,
        recordedAt: now.toISOString(),
      }),
    )
    return right(entry)
  }

  static rehydrate(props: EntryProps, id: UniqueEntityID): JournalEntry {
    return new JournalEntry(props, id)
  }

  get accountId(): string {
    return this.props.accountId
  }

  get source(): EntrySource {
    return this.props.source
  }

  get direction(): EntryDirection {
    return this.props.direction
  }

  get amount(): Money {
    return this.props.amount
  }

  /** The signed effect on the account balance, in minor units. */
  effect(): bigint {
    return this.props.direction === 'inflow' ? this.props.amount.amount : -this.props.amount.amount
  }

  /**
   * The inverse entry. `valueOn` defaults to the original date, so the correction nets out
   * on the day the mistake was made; a later date keeps the history as it was seen.
   */
  reverse(
    reason: Reason,
    now: Date,
    options: { valueOn?: BusinessDate; fromTransfer?: boolean } = {},
  ): Either<ConflictError | InvalidInputError, JournalEntry> {
    if (this.props.source === 'reversal')
      return left(new ConflictError('a reversal cannot itself be reversed; record a new entry'))
    if (this.props.source === 'opening')
      return left(new ConflictError('an opening balance is corrected with a manual entry'))
    const isTransferLeg = this.props.source === 'transfer' || this.props.source === 'transfer-fee'
    if (isTransferLeg && !options.fromTransfer)
      return left(new ConflictError('a transfer leg is undone by cancelling the transfer'))
    return JournalEntry.record({
      tenantId: this.props.tenantId,
      accountId: this.props.accountId,
      direction: this.props.direction === 'inflow' ? 'outflow' : 'inflow',
      amount: this.props.amount,
      valueOn: options.valueOn ?? this.props.valueOn,
      source: 'reversal',
      transferId: this.props.transferId,
      reverses: this.id.toString(),
      counterparty: this.props.counterparty,
      memo: null,
      reason,
      now,
    })
  }

  toSnapshot(): Readonly<EntrySnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      accountId: this.props.accountId,
      direction: this.props.direction,
      amount: this.props.amount.amount.toString(),
      currency: this.props.amount.currency.value,
      valueOn: this.props.valueOn.value,
      source: this.props.source,
      transferId: this.props.transferId,
      reverses: this.props.reverses,
      counterparty: this.props.counterparty?.value ?? null,
      memo: this.props.memo?.value ?? null,
      reason: this.props.reason?.value ?? null,
      recordedAt: this.props.recordedAt,
    })
  }
}

/** The book balance a journal adds up to: inflows minus outflows. */
export function bookBalance(entries: readonly JournalEntry[]): bigint {
  return entries.reduce((balance, entry) => balance + entry.effect(), 0n)
}
