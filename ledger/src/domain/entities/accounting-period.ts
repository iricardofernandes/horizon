import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { LedgerEvent } from '../events/ledger-events'
import type { Period, Reason } from '../value-objects/ledger-values'

export const PERIOD_STATUSES = ['open', 'closed'] as const
export type PeriodStatus = (typeof PERIOD_STATUSES)[number]

interface PeriodProps {
  tenantId: string
  period: Period
  status: PeriodStatus
  closedBy: string
  closedAt: Date
  reopenedBy: string | null
  reopenedAt: Date | null
  reopenReason: Reason | null
}

export interface PeriodSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly period: string
  readonly status: PeriodStatus
  readonly closedBy: string
  readonly closedAt: Date
  readonly reopenedBy: string | null
  readonly reopenedAt: Date | null
  readonly reopenReason: string | null
}

/**
 * A calendar month that has been closed at least once.
 *
 * A month with no record is open, which is why nothing is written when a ledger starts:
 * the table holds decisions, not a row per month forever. Reopening keeps who did it and
 * why, because reopening a closed month is an accounting event in its own right.
 */
export class AccountingPeriod extends AggregateRoot<PeriodProps> {
  static close(
    props: { tenantId: string; period: Period; actor: string; now: Date },
    id?: UniqueEntityID,
  ): AccountingPeriod {
    const closure = new AccountingPeriod(
      {
        tenantId: props.tenantId,
        period: props.period,
        status: 'closed',
        closedBy: props.actor,
        closedAt: props.now,
        reopenedBy: null,
        reopenedAt: null,
        reopenReason: null,
      },
      id,
    )
    closure.announceClosed(props.now)
    return closure
  }

  static rehydrate(props: PeriodProps, id: UniqueEntityID): AccountingPeriod {
    return new AccountingPeriod(props, id)
  }

  get period(): string {
    return this.props.period.value
  }

  get status(): PeriodStatus {
    return this.props.status
  }

  isClosed(): boolean {
    return this.props.status === 'closed'
  }

  closeAgain(actor: string, now: Date): Either<ConflictError, void> {
    if (this.props.status === 'closed')
      return left(new ConflictError(`period ${this.period} is already closed`))
    this.props.status = 'closed'
    this.props.closedBy = actor
    this.props.closedAt = now
    this.props.reopenedBy = null
    this.props.reopenedAt = null
    this.props.reopenReason = null
    this.announceClosed(now)
    return right(undefined)
  }

  reopen(actor: string, reason: Reason, now: Date): Either<ConflictError, void> {
    if (this.props.status === 'open')
      return left(new ConflictError(`period ${this.period} is already open`))
    this.props.status = 'open'
    this.props.reopenedBy = actor
    this.props.reopenedAt = now
    this.props.reopenReason = reason
    this.addDomainEvent(
      new LedgerEvent('ledger.period.reopened', this.id, this.props.tenantId, now, {
        periodId: this.id.toString(),
        period: this.period,
        reopenedAt: now.toISOString(),
        reason: reason.value,
      }),
    )
    return right(undefined)
  }

  private announceClosed(now: Date): void {
    this.addDomainEvent(
      new LedgerEvent('ledger.period.closed', this.id, this.props.tenantId, now, {
        periodId: this.id.toString(),
        period: this.period,
        closedAt: now.toISOString(),
      }),
    )
  }

  toSnapshot(): Readonly<PeriodSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      period: this.props.period.value,
      status: this.props.status,
      closedBy: this.props.closedBy,
      closedAt: this.props.closedAt,
      reopenedBy: this.props.reopenedBy,
      reopenedAt: this.props.reopenedAt,
      reopenReason: this.props.reopenReason?.value ?? null,
    })
  }
}
