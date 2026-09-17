import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { LedgerEvent, moneyPayload } from '../events/ledger-events'
import type {
  BusinessDate,
  Currency,
  Memo,
  Reason,
  Reference,
} from '../value-objects/ledger-values'
import { Money, Period } from '../value-objects/ledger-values'
import type { EntrySide } from './ledger-account'

/**
 * The business fact a transaction accounts for. `manual` is a person writing the entry;
 * every other value names a fact another module reported, and the source id is that fact's
 * own identifier — never the event id, so a redelivery resolves to the same posting.
 */
export const TRANSACTION_SOURCES = [
  'manual',
  'receivable',
  'payable',
  'settlement',
  'transfer',
  'treasury-entry',
] as const
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number]

export const TRANSACTION_STATUSES = ['posted', 'reversed'] as const
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number]

/** One side of one account, before it is numbered. */
export interface DraftLine {
  readonly accountId: string
  readonly accountCode: string
  readonly side: EntrySide
  readonly amount: Money
  readonly memo: Memo | null
}

export interface TransactionLine extends DraftLine {
  readonly lineNumber: number
}

export interface LineSnapshot {
  readonly lineNumber: number
  readonly accountId: string
  readonly accountCode: string
  readonly side: EntrySide
  readonly amount: string
  readonly memo: string | null
}

export interface TransactionSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly reference: string
  readonly postedOn: string
  readonly period: string
  readonly currency: string
  readonly total: string
  readonly sourceType: TransactionSource
  readonly sourceId: string | null
  readonly memo: string | null
  readonly status: TransactionStatus
  readonly reverses: string | null
  readonly reversedBy: string | null
  readonly reversalReason: string | null
  readonly postedAt: Date
  readonly reversedAt: Date | null
  readonly lines: readonly LineSnapshot[]
}

interface TransactionProps {
  tenantId: string
  reference: Reference
  postedOn: BusinessDate
  period: Period
  currency: Currency
  source: { type: TransactionSource; id: string | null }
  memo: Memo | null
  lines: readonly TransactionLine[]
  status: TransactionStatus
  reverses: string | null
  reversedBy: string | null
  reversalReason: Reason | null
  postedAt: Date
  reversedAt: Date | null
}

function sideTotal(lines: readonly DraftLine[], side: EntrySide): bigint {
  return lines.reduce((sum, line) => (line.side === side ? sum + line.amount.amount : sum), 0n)
}

/**
 * A balanced set of lines posted on one date, in one currency.
 *
 * Balance is the whole point and is checked here, once: a transaction whose debits and
 * credits disagree never exists as an object, so no repository, report or consumer has to
 * cope with one. A mistake is undone by a mirror transaction, never by editing this one
 * (ADR 0042), which is why `reverse` returns a second aggregate instead of changing lines.
 */
export class JournalTransaction extends AggregateRoot<TransactionProps> {
  static post(
    props: {
      tenantId: string
      reference: Reference
      postedOn: BusinessDate
      currency: Currency
      source: { type: TransactionSource; id: string | null }
      memo: Memo | null
      lines: readonly DraftLine[]
      now: Date
      reverses?: string | null
    },
    id?: UniqueEntityID,
  ): Either<InvalidInputError, JournalTransaction> {
    const checked = JournalTransaction.check(props.lines, props.currency)
    if (checked.isLeft()) return left(checked.value)
    const transaction = new JournalTransaction(
      {
        tenantId: props.tenantId,
        reference: props.reference,
        postedOn: props.postedOn,
        period: Period.of(props.postedOn),
        currency: props.currency,
        source: props.source,
        memo: props.memo,
        lines: props.lines.map((line, index) => ({ ...line, lineNumber: index + 1 })),
        status: 'posted',
        reverses: props.reverses ?? null,
        reversedBy: null,
        reversalReason: null,
        postedAt: props.now,
        reversedAt: null,
      },
      id,
    )
    transaction.addDomainEvent(
      new LedgerEvent('ledger.transaction.posted', transaction.id, props.tenantId, props.now, {
        transactionId: transaction.id.toString(),
        reference: props.reference.value,
        postedOn: props.postedOn.value,
        period: Period.of(props.postedOn).value,
        total: moneyPayload(transaction.total),
        source: props.source,
        lines: transaction.props.lines.map((line) => ({
          lineNumber: line.lineNumber,
          accountId: line.accountId,
          accountCode: line.accountCode,
          side: line.side,
          amount: moneyPayload(line.amount),
          memo: line.memo?.value ?? null,
        })),
        postedAt: props.now.toISOString(),
      }),
    )
    return right(transaction)
  }

  private static check(
    lines: readonly DraftLine[],
    currency: Currency,
  ): Either<InvalidInputError, void> {
    if (lines.length < 2)
      return left(new InvalidInputError('/lines', 'must contain at least a debit and a credit'))
    for (const [index, line] of lines.entries()) {
      if (line.amount.isZero())
        return left(new InvalidInputError(`/lines/${index}/amount`, 'must be greater than zero'))
      if (!line.amount.currency.equals(currency))
        return left(
          new InvalidInputError(
            `/lines/${index}/amount`,
            `must be in ${currency.value}, the transaction currency`,
          ),
        )
    }
    const debits = sideTotal(lines, 'debit')
    const credits = sideTotal(lines, 'credit')
    if (debits !== credits)
      return left(
        new InvalidInputError(
          '/lines',
          `do not balance: ${debits} debit against ${credits} credit`,
        ),
      )
    return right(undefined)
  }

  static rehydrate(props: TransactionProps, id: UniqueEntityID): JournalTransaction {
    return new JournalTransaction(props, id)
  }

  get tenantId(): string {
    return this.props.tenantId
  }

  get period(): string {
    return this.props.period.value
  }

  get postedOn(): string {
    return this.props.postedOn.value
  }

  get status(): TransactionStatus {
    return this.props.status
  }

  get lines(): readonly TransactionLine[] {
    return this.props.lines
  }

  /** The debit total, which balance makes the credit total as well. */
  get total(): Money {
    return Money.of(sideTotal(this.props.lines, 'debit'), this.props.currency)
  }

  /**
   * The mirror transaction. Every side is swapped and the amounts are untouched, so the
   * two together leave every account exactly where it was.
   */
  reverse(
    reason: Reason,
    now: Date,
    options: { reversalOn?: BusinessDate } = {},
  ): Either<ConflictError | InvalidInputError, JournalTransaction> {
    if (this.props.status === 'reversed')
      return left(new ConflictError('the transaction is already reversed'))
    if (this.props.reverses)
      return left(new ConflictError('a reversal cannot itself be reversed; post a new transaction'))
    const reversal = JournalTransaction.post({
      tenantId: this.props.tenantId,
      reference: this.props.reference,
      postedOn: options.reversalOn ?? this.props.postedOn,
      currency: this.props.currency,
      source: this.props.source,
      memo: this.props.memo,
      reverses: this.id.toString(),
      lines: this.props.lines.map((line) => ({
        accountId: line.accountId,
        accountCode: line.accountCode,
        side: line.side === 'debit' ? ('credit' as const) : ('debit' as const),
        amount: line.amount,
        memo: line.memo,
      })),
      now,
    })
    if (reversal.isLeft()) return left(reversal.value)
    this.props.status = 'reversed'
    this.props.reversedBy = reversal.value.id.toString()
    this.props.reversalReason = reason
    this.props.reversedAt = now
    this.addDomainEvent(
      new LedgerEvent('ledger.transaction.reversed', this.id, this.props.tenantId, now, {
        transactionId: this.id.toString(),
        reversalId: reversal.value.id.toString(),
        reversedAt: now.toISOString(),
        reason: reason.value,
      }),
    )
    return right(reversal.value)
  }

  toSnapshot(): Readonly<TransactionSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      reference: this.props.reference.value,
      postedOn: this.props.postedOn.value,
      period: this.props.period.value,
      currency: this.props.currency.value,
      total: this.total.amount.toString(),
      sourceType: this.props.source.type,
      sourceId: this.props.source.id,
      memo: this.props.memo?.value ?? null,
      status: this.props.status,
      reverses: this.props.reverses,
      reversedBy: this.props.reversedBy,
      reversalReason: this.props.reversalReason?.value ?? null,
      postedAt: this.props.postedAt,
      reversedAt: this.props.reversedAt,
      lines: this.props.lines.map((line) => ({
        lineNumber: line.lineNumber,
        accountId: line.accountId,
        accountCode: line.accountCode,
        side: line.side,
        amount: line.amount.amount.toString(),
        memo: line.memo?.value ?? null,
      })),
    })
  }
}
