import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import {
  type BusinessDate,
  type Money,
  type Name,
  type Share,
  WHOLE,
} from '../value-objects/financial-values'

export const MAX_INSTALLMENTS = 120
export const MAX_DUE_IN_DAYS = 3650

export interface InstallmentRule {
  readonly dueInDays: number
  readonly share: Share
}

export interface ScheduledInstallment {
  readonly number: number
  readonly dueOn: BusinessDate
  readonly amount: Money
}

interface PaymentTermProps {
  tenantId: string
  name: Name
  installments: readonly InstallmentRule[]
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export interface PaymentTermSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly name: string
  readonly installments: readonly { readonly dueInDays: number; readonly basisPoints: number }[]
  readonly active: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * How an amount is split into installments and when each falls due: "30/60/90", "50%
 * upfront and 50% in 30 days".
 *
 * The shares must add up to exactly 100% and the due days may never go backwards. A term
 * that adds up to 99.99% silently drops a cent on every title issued with it.
 */
export class PaymentTerm extends AggregateRoot<PaymentTermProps> {
  static define(
    props: { tenantId: string; name: Name; installments: readonly InstallmentRule[]; now: Date },
    id?: UniqueEntityID,
  ): Either<InvalidInputError, PaymentTerm> {
    const rules = props.installments
    if (rules.length < 1 || rules.length > MAX_INSTALLMENTS)
      return left(
        new InvalidInputError(
          '/installments',
          `must contain between 1 and ${MAX_INSTALLMENTS} installments`,
        ),
      )
    const total = rules.reduce((sum, rule) => sum + rule.share.basisPoints, 0)
    if (total !== WHOLE)
      return left(
        new InvalidInputError(
          '/installments',
          'installment percentages must add up to exactly 100%',
        ),
      )
    for (const [index, rule] of rules.entries()) {
      if (
        !Number.isInteger(rule.dueInDays) ||
        rule.dueInDays < 0 ||
        rule.dueInDays > MAX_DUE_IN_DAYS
      )
        return left(
          new InvalidInputError(
            `/installments/${index}/dueInDays`,
            `must be a whole number of days from 0 to ${MAX_DUE_IN_DAYS}`,
          ),
        )
      const previous = rules[index - 1]
      if (previous && rule.dueInDays < previous.dueInDays)
        return left(
          new InvalidInputError(
            `/installments/${index}/dueInDays`,
            'installments cannot fall due before the one preceding them',
          ),
        )
    }
    return right(
      new PaymentTerm(
        {
          tenantId: props.tenantId,
          name: props.name,
          installments: [...rules],
          active: true,
          createdAt: props.now,
          updatedAt: props.now,
        },
        id,
      ),
    )
  }

  static rehydrate(props: PaymentTermProps, id: UniqueEntityID): PaymentTerm {
    return new PaymentTerm(props, id)
  }

  isActive(): boolean {
    return this.props.active
  }

  /** The installments an amount issued on a date would produce. Always sums to the amount. */
  schedule(total: Money, issuedOn: BusinessDate): ScheduledInstallment[] {
    const amounts = total.allocate(this.props.installments.map((rule) => rule.share))
    return this.props.installments.map((rule, index) => ({
      number: index + 1,
      dueOn: issuedOn.plusDays(rule.dueInDays),
      amount: amounts[index] ?? total,
    }))
  }

  changeStatus(active: boolean, now: Date): Either<ConflictError, void> {
    if (this.props.active === active)
      return left(new ConflictError(`payment term is already ${active ? 'active' : 'inactive'}`))
    this.props.active = active
    this.props.updatedAt = now
    return right(undefined)
  }

  toSnapshot(): Readonly<PaymentTermSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      name: this.props.name.value,
      installments: this.props.installments.map((rule) => ({
        dueInDays: rule.dueInDays,
        basisPoints: rule.share.basisPoints,
      })),
      active: this.props.active,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
