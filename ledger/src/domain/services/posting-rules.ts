import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { PostingChart, PostingRole } from '../entities/account-mapping'
import type { EntrySide } from '../entities/ledger-account'

/** What another module reported, reduced to the numbers the books care about. */
export type Fact =
  | {
      readonly kind: 'receivable' | 'payable'
      readonly id: string
      readonly reference: string
      readonly on: string
      readonly currency: string
      readonly categoryId: string
      readonly total: bigint
    }
  | {
      readonly kind: 'settlement'
      readonly id: string
      readonly reference: string
      readonly on: string
      readonly currency: string
      readonly direction: 'receivable' | 'payable'
      readonly treasuryAccountId: string | null
      readonly received: bigint
      readonly discount: bigint
      readonly interest: bigint
      readonly penalty: bigint
    }
  | {
      readonly kind: 'transfer'
      readonly id: string
      readonly reference: string
      readonly on: string
      readonly currency: string
      readonly fromAccountId: string
      readonly toAccountId: string
      readonly amount: bigint
      readonly fee: bigint
    }
  | {
      readonly kind: 'treasury-entry'
      readonly id: string
      readonly reference: string
      readonly on: string
      readonly currency: string
      readonly accountId: string
      readonly source: 'opening' | 'manual'
      readonly direction: 'inflow' | 'outflow'
      readonly amount: bigint
    }

export interface PlannedLine {
  readonly accountId: string
  readonly side: EntrySide
  readonly amount: bigint
  readonly memo: string | null
}

const opposite = (side: EntrySide): EntrySide => (side === 'debit' ? 'credit' : 'debit')

/** A leg of a fixed side, dropped when it is zero: a line of nothing is not a line. */
function leg(
  accountId: string,
  side: EntrySide,
  amount: bigint,
  memo: string | null,
): PlannedLine[] {
  return amount === 0n ? [] : [{ accountId, side, amount, memo }]
}

/**
 * A leg whose side follows the sign of what is left.
 *
 * A settlement that charges more interest than it collects cash *raises* what the party
 * owes, so the receivable leg is a debit that day rather than a credit. Deciding this from
 * the arithmetic, rather than from the kind of event, is what keeps the balance identity
 * true for every combination of cash, discount, interest and penalty.
 */
function netLeg(
  accountId: string,
  net: bigint,
  whenPositive: EntrySide,
  memo: string | null,
): PlannedLine[] {
  if (net === 0n) return []
  return [
    {
      accountId,
      side: net > 0n ? whenPositive : opposite(whenPositive),
      amount: net > 0n ? net : -net,
      memo,
    },
  ]
}

class Resolver {
  readonly missing: PostingRole[] = []
  constructor(private readonly chart: PostingChart) {}

  /** The account for a part, remembering any part the workspace has not mapped at all. */
  of(role: PostingRole, key: string | null = null): string {
    const found = this.chart.resolve(role, key)
    if (found === null) {
      this.missing.push(role)
      return ''
    }
    return found
  }
}

export interface PostingPlan {
  readonly reference: string
  readonly postedOn: string
  readonly currency: string
  readonly source: { readonly type: Fact['kind']; readonly id: string }
  readonly lines: readonly PlannedLine[]
}

/**
 * The posting rules, in one place.
 *
 * They are code rather than configuration on purpose: a posting rule is accounting policy,
 * and a rule engine a workspace can edit is a ledger nobody can audit. What a workspace
 * chooses is which of its accounts plays each part — see `AccountMapping`.
 */
export function planPosting(fact: Fact, chart: PostingChart): Either<ConflictError, PostingPlan> {
  const resolver = new Resolver(chart)
  const lines = linesFor(fact, resolver)
  if (resolver.missing.length > 0) {
    const parts = [...new Set(resolver.missing)].join(', ')
    return left(new ConflictError(`no account is mapped for: ${parts}`))
  }
  if (lines.length < 2)
    return left(new ConflictError('the fact has nothing to post: every amount is zero'))
  return right({
    reference: fact.reference,
    postedOn: fact.on,
    currency: fact.currency,
    source: { type: fact.kind, id: fact.id },
    lines,
  })
}

function linesFor(fact: Fact, accounts: Resolver): PlannedLine[] {
  switch (fact.kind) {
    case 'receivable':
      return [
        ...leg(accounts.of('receivables'), 'debit', fact.total, fact.reference),
        ...leg(accounts.of('revenue', fact.categoryId), 'credit', fact.total, fact.reference),
      ]
    case 'payable':
      return [
        ...leg(accounts.of('expense', fact.categoryId), 'debit', fact.total, fact.reference),
        ...leg(accounts.of('payables'), 'credit', fact.total, fact.reference),
      ]
    case 'settlement':
      return settlementLines(fact, accounts)
    case 'transfer':
      return transferLines(fact, accounts)
    case 'treasury-entry':
      return treasuryEntryLines(fact, accounts)
  }
}

function settlementLines(
  fact: Extract<Fact, { kind: 'settlement' }>,
  accounts: Resolver,
): PlannedLine[] {
  const cash = accounts.of('cash', fact.treasuryAccountId)
  const charges = fact.interest + fact.penalty
  // What the party still owed and no longer does: the cash and the discount, less what
  // this settlement added to the debt.
  const owed = fact.received + fact.discount - charges
  if (fact.direction === 'receivable')
    return [
      ...leg(cash, 'debit', fact.received, fact.reference),
      ...leg(accounts.of('discount-granted'), 'debit', fact.discount, fact.reference),
      ...leg(accounts.of('financial-income'), 'credit', charges, fact.reference),
      ...netLeg(accounts.of('receivables'), owed, 'credit', fact.reference),
    ]
  return [
    ...leg(cash, 'credit', fact.received, fact.reference),
    ...leg(accounts.of('discount-received'), 'credit', fact.discount, fact.reference),
    ...leg(accounts.of('financial-expense'), 'debit', charges, fact.reference),
    ...netLeg(accounts.of('payables'), owed, 'debit', fact.reference),
  ]
}

/**
 * Moving money between two of the workspace's own accounts changes nothing it owns, so a
 * transfer never touches profit or loss. The fee the bank charges for moving it does.
 */
function transferLines(
  fact: Extract<Fact, { kind: 'transfer' }>,
  accounts: Resolver,
): PlannedLine[] {
  const from = accounts.of('cash', fact.fromAccountId)
  return [
    ...leg(accounts.of('cash', fact.toAccountId), 'debit', fact.amount, fact.reference),
    ...leg(from, 'credit', fact.amount, fact.reference),
    ...leg(accounts.of('bank-fees'), 'debit', fact.fee, fact.reference),
    ...leg(from, 'credit', fact.fee, fact.reference),
  ]
}

/**
 * Only the treasury movements no other event already accounts for. A transfer leg, its
 * fee, a settlement and a reversal all reach the ledger through the fact that caused them;
 * posting the journal line as well would count each of them twice.
 */
function treasuryEntryLines(
  fact: Extract<Fact, { kind: 'treasury-entry' }>,
  accounts: Resolver,
): PlannedLine[] {
  const cash = accounts.of('cash', fact.accountId)
  // An opening balance is where the account started; a manual entry has no category to
  // classify it by, so it waits in suspense for a person to say what it was.
  const other = accounts.of(fact.source === 'opening' ? 'opening-balance' : 'suspense')
  const cashSide: EntrySide = fact.direction === 'inflow' ? 'debit' : 'credit'
  return [
    ...leg(cash, cashSide, fact.amount, fact.reference),
    ...leg(other, opposite(cashSide), fact.amount, fact.reference),
  ]
}
