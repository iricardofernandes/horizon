import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { TreasuryEvent } from '../events/treasury-events'
import type {
  AccountName,
  BankDetails,
  BusinessDate,
  Currency,
} from '../value-objects/treasury-values'

export const ACCOUNT_KINDS = ['bank', 'cash', 'card-clearing', 'virtual'] as const
export type AccountKind = (typeof ACCOUNT_KINDS)[number]

interface AccountProps {
  tenantId: string
  kind: AccountKind
  name: AccountName
  currency: Currency
  bank: BankDetails | null
  openedOn: BusinessDate
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export interface AccountSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly kind: AccountKind
  readonly name: string
  readonly currency: string
  readonly bankCode: string | null
  readonly branch: string | null
  readonly accountNumber: string | null
  readonly openedOn: string
  readonly active: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * Where money is kept: a bank account, a cash drawer, a card clearing account or a virtual
 * one. The account holds no balance of its own — its balance is always the sum of its
 * journal, so no update can make the two disagree.
 */
export class Account extends AggregateRoot<AccountProps> {
  static open(
    props: {
      tenantId: string
      kind: AccountKind
      name: AccountName
      currency: Currency
      bank: BankDetails | null
      openedOn: BusinessDate
      now: Date
    },
    id?: UniqueEntityID,
  ): Account {
    const account = new Account(
      {
        tenantId: props.tenantId,
        kind: props.kind,
        name: props.name,
        currency: props.currency,
        bank: props.kind === 'bank' ? props.bank : null,
        openedOn: props.openedOn,
        active: true,
        createdAt: props.now,
        updatedAt: props.now,
      },
      id,
    )
    account.addDomainEvent(
      new TreasuryEvent('treasury.account.opened', account.id, props.tenantId, props.now, {
        accountId: account.id.toString(),
        kind: props.kind,
        name: props.name.value,
        currency: props.currency.value,
        openedOn: props.openedOn.value,
      }),
    )
    return account
  }

  static rehydrate(props: AccountProps, id: UniqueEntityID): Account {
    return new Account(props, id)
  }

  get tenantId(): string {
    return this.props.tenantId
  }

  get currency(): Currency {
    return this.props.currency
  }

  get openedOn(): BusinessDate {
    return this.props.openedOn
  }

  get name(): string {
    return this.props.name.value
  }

  /** Can this account take a new entry of this currency on this date? */
  accepts(currency: Currency, valueOn: BusinessDate): Either<ConflictError, void> {
    if (!this.props.active)
      return left(new ConflictError(`account ${this.props.name.value} is inactive`))
    if (!currency.equals(this.props.currency))
      return left(
        new ConflictError(`account ${this.props.name.value} holds ${this.props.currency.value}`),
      )
    if (valueOn.isBefore(this.props.openedOn))
      return left(
        new ConflictError(
          `account ${this.props.name.value} was opened on ${this.props.openedOn.value}`,
        ),
      )
    return right(undefined)
  }

  changeStatus(active: boolean, now: Date): Either<ConflictError, void> {
    if (this.props.active === active)
      return left(new ConflictError(`account is already ${active ? 'active' : 'inactive'}`))
    this.props.active = active
    this.props.updatedAt = now
    return right(undefined)
  }

  toSnapshot(): Readonly<AccountSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      kind: this.props.kind,
      name: this.props.name.value,
      currency: this.props.currency.value,
      bankCode: this.props.bank?.bankCode ?? null,
      branch: this.props.bank?.branch ?? null,
      accountNumber: this.props.bank?.accountNumber ?? null,
      openedOn: this.props.openedOn.value,
      active: this.props.active,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
