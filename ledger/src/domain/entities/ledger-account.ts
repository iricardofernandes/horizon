import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { LedgerEvent } from '../events/ledger-events'
import type { AccountCode, AccountName, Currency, Money } from '../value-objects/ledger-values'

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const ENTRY_SIDES = ['debit', 'credit'] as const
export type EntrySide = (typeof ENTRY_SIDES)[number]

/**
 * Which side increases an account of this type. It is a property of the type, not a
 * separate column, so no account can be stored with a normal balance its type denies.
 */
export function normalBalanceOf(type: AccountType): EntrySide {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit'
}

/** Debits minus credits for a debit account, and the other way round for a credit account. */
export function balanceOf(type: AccountType, debits: bigint, credits: bigint): bigint {
  return normalBalanceOf(type) === 'debit' ? debits - credits : credits - debits
}

interface AccountProps {
  tenantId: string
  code: AccountCode
  name: AccountName
  type: AccountType
  parentId: string | null
  postable: boolean
  currency: Currency
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export interface AccountSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly code: string
  readonly name: string
  readonly type: AccountType
  readonly parentId: string | null
  readonly postable: boolean
  readonly currency: string
  readonly active: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * One line of the chart of accounts.
 *
 * The chart is a tree: a parent exists to total its children and never takes a line of
 * its own, and only a leaf is `postable`. That is enforced when a child is opened — a
 * postable account refuses to become a parent — so the two rules cannot drift apart as
 * the chart grows.
 */
export class LedgerAccount extends AggregateRoot<AccountProps> {
  static open(
    props: {
      tenantId: string
      code: AccountCode
      name: AccountName
      type: AccountType
      parent: LedgerAccount | null
      postable: boolean
      currency: Currency
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<InvalidInputError | ConflictError, LedgerAccount> {
    const placed = LedgerAccount.place(props)
    if (placed.isLeft()) return left(placed.value)
    const account = new LedgerAccount(
      {
        tenantId: props.tenantId,
        code: props.code,
        name: props.name,
        type: props.type,
        parentId: props.parent?.id.toString() ?? null,
        postable: props.postable,
        currency: props.currency,
        active: true,
        createdAt: props.now,
        updatedAt: props.now,
      },
      id,
    )
    account.addDomainEvent(
      new LedgerEvent('ledger.account.opened', account.id, props.tenantId, props.now, {
        accountId: account.id.toString(),
        code: props.code.value,
        name: props.name.value,
        type: props.type,
        parentId: props.parent?.id.toString() ?? null,
        postable: props.postable,
        currency: props.currency.value,
        openedAt: props.now.toISOString(),
      }),
    )
    return right(account)
  }

  /** Does this code, type and currency belong under that parent — or at the root? */
  private static place(props: {
    code: AccountCode
    type: AccountType
    parent: LedgerAccount | null
    currency: Currency
  }): Either<InvalidInputError | ConflictError, void> {
    const { parent } = props
    if (!parent)
      return props.code.depth === 1
        ? right(undefined)
        : left(new InvalidInputError('/code', 'a top-level account has a single-group code'))
    if (parent.postable)
      return left(
        new ConflictError(`account ${parent.code} takes postings and cannot have children`),
      )
    if (parent.type !== props.type)
      return left(new ConflictError(`account ${parent.code} is ${parent.type}`))
    if (!parent.currency.equals(props.currency))
      return left(new ConflictError(`account ${parent.code} is kept in ${parent.currency.value}`))
    if (!props.code.isChildOf(parent.props.code))
      return left(new InvalidInputError('/code', `must extend the parent code ${parent.code}`))
    return right(undefined)
  }

  static rehydrate(props: AccountProps, id: UniqueEntityID): LedgerAccount {
    return new LedgerAccount(props, id)
  }

  get tenantId(): string {
    return this.props.tenantId
  }

  get code(): string {
    return this.props.code.value
  }

  get name(): string {
    return this.props.name.value
  }

  get type(): AccountType {
    return this.props.type
  }

  get postable(): boolean {
    return this.props.postable
  }

  get currency(): Currency {
    return this.props.currency
  }

  get normalBalance(): EntrySide {
    return normalBalanceOf(this.props.type)
  }

  /** Can this account take a line of this amount? */
  accepts(amount: Money): Either<ConflictError, void> {
    if (!this.props.postable)
      return left(new ConflictError(`account ${this.code} totals its children and takes no lines`))
    if (!this.props.active) return left(new ConflictError(`account ${this.code} is inactive`))
    if (!amount.currency.equals(this.props.currency))
      return left(new ConflictError(`account ${this.code} is kept in ${this.props.currency.value}`))
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
      code: this.props.code.value,
      name: this.props.name.value,
      type: this.props.type,
      parentId: this.props.parentId,
      postable: this.props.postable,
      currency: this.props.currency.value,
      active: this.props.active,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
