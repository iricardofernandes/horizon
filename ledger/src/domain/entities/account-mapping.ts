import { type Either, left, right } from '@/core/either'
import { Entity } from '@/core/entities/entity'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { AccountType, LedgerAccount } from './ledger-account'

/**
 * The part an account plays when a fact from another module is posted.
 *
 * These are the whole vocabulary of the automatic postings: the rules themselves are
 * fixed code, because a posting rule *is* accounting policy and a configurable rule engine
 * is a way to make the books unauditable. What a workspace chooses is which of its own
 * accounts plays each part.
 */
export const POSTING_ROLES = [
  'receivables',
  'payables',
  'cash',
  'revenue',
  'expense',
  'discount-granted',
  'discount-received',
  'financial-income',
  'financial-expense',
  'bank-fees',
  'opening-balance',
  'suspense',
] as const
export type PostingRole = (typeof POSTING_ROLES)[number]

/**
 * The account type each role must be, so a mapping cannot quietly send revenue to an
 * asset account and leave every report wrong in a way no total would reveal.
 */
const REQUIRED_TYPE: Readonly<Record<PostingRole, AccountType>> = {
  receivables: 'asset',
  payables: 'liability',
  cash: 'asset',
  revenue: 'revenue',
  expense: 'expense',
  'discount-granted': 'expense',
  'discount-received': 'revenue',
  'financial-income': 'revenue',
  'financial-expense': 'expense',
  'bank-fees': 'expense',
  'opening-balance': 'equity',
  suspense: 'asset',
}

/** Roles that are chosen per source record: a cash account per treasury account, and so on. */
const KEYED_ROLES: Readonly<Record<PostingRole, boolean>> = {
  receivables: false,
  payables: false,
  cash: true,
  revenue: true,
  expense: true,
  'discount-granted': false,
  'discount-received': false,
  'financial-income': false,
  'financial-expense': false,
  'bank-fees': false,
  'opening-balance': false,
  suspense: false,
}

interface MappingProps {
  tenantId: string
  role: PostingRole
  /** The treasury account or financial category this mapping is for; null is the default. */
  key: string | null
  accountId: string
  accountCode: string
  updatedBy: string
  updatedAt: Date
}

export interface MappingSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly role: PostingRole
  readonly key: string | null
  readonly accountId: string
  readonly accountCode: string
  readonly updatedBy: string
  readonly updatedAt: Date
}

/** Which of the workspace's accounts plays one part, for one source record or by default. */
export class AccountMapping extends Entity<MappingProps> {
  static define(
    props: {
      tenantId: string
      role: PostingRole
      key: string | null
      account: LedgerAccount
      actor: string
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<ConflictError, AccountMapping> {
    const checked = AccountMapping.check(props.role, props.key, props.account)
    if (checked.isLeft()) return left(checked.value)
    return right(
      new AccountMapping(
        {
          tenantId: props.tenantId,
          role: props.role,
          key: props.key,
          accountId: props.account.id.toString(),
          accountCode: props.account.code,
          updatedBy: props.actor,
          updatedAt: props.now,
        },
        id,
      ),
    )
  }

  private static check(
    role: PostingRole,
    key: string | null,
    account: LedgerAccount,
  ): Either<ConflictError, void> {
    if (key !== null && !KEYED_ROLES[role])
      return left(new ConflictError(`the ${role} account is chosen once, not per record`))
    if (account.type !== REQUIRED_TYPE[role])
      return left(
        new ConflictError(
          `the ${role} account must be ${REQUIRED_TYPE[role]}, not ${account.type}`,
        ),
      )
    if (!account.postable)
      return left(
        new ConflictError(`account ${account.code} totals its children and takes no lines`),
      )
    return right(undefined)
  }

  static rehydrate(props: MappingProps, id: UniqueEntityID): AccountMapping {
    return new AccountMapping(props, id)
  }

  get role(): PostingRole {
    return this.props.role
  }

  get key(): string | null {
    return this.props.key
  }

  get accountId(): string {
    return this.props.accountId
  }

  get accountCode(): string {
    return this.props.accountCode
  }

  pointAt(account: LedgerAccount, actor: string, now: Date): Either<ConflictError, void> {
    const checked = AccountMapping.check(this.props.role, this.props.key, account)
    if (checked.isLeft()) return left(checked.value)
    this.props.accountId = account.id.toString()
    this.props.accountCode = account.code
    this.props.updatedBy = actor
    this.props.updatedAt = now
    return right(undefined)
  }

  toSnapshot(): Readonly<MappingSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      role: this.props.role,
      key: this.props.key,
      accountId: this.props.accountId,
      accountCode: this.props.accountCode,
      updatedBy: this.props.updatedBy,
      updatedAt: this.props.updatedAt,
    })
  }
}

/**
 * The mappings in force, ready to answer "which account plays this part for this record".
 *
 * Resolution is exact, then the role's default, then suspense. Suspense keeps the books
 * complete when a category has no account yet — the transaction still balances, and the
 * accountant reclassifies it — rather than losing the fact or blocking the queue.
 */
export class PostingChart {
  private readonly byRole = new Map<string, string>()

  constructor(mappings: readonly AccountMapping[]) {
    for (const mapping of mappings)
      this.byRole.set(keyOf(mapping.role, mapping.key), mapping.accountId)
  }

  /** The account for this part, or null when neither it, its default nor suspense is mapped. */
  resolve(role: PostingRole, key: string | null = null): string | null {
    return (
      (key === null ? null : (this.byRole.get(keyOf(role, key)) ?? null)) ??
      this.byRole.get(keyOf(role, null)) ??
      this.byRole.get(keyOf('suspense', null)) ??
      null
    )
  }

  /** Whether a role has an account of its own, ignoring the suspense fallback. */
  has(role: PostingRole, key: string | null = null): boolean {
    return (
      this.byRole.has(keyOf(role, key === null ? null : key)) || this.byRole.has(keyOf(role, null))
    )
  }
}

/** Roles never contain a colon and keys are identifiers, so this pair cannot be ambiguous. */
function keyOf(role: string, key: string | null): string {
  return `${role}:${key ?? ''}`
}
