import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { AccountMapping, PostingChart, type PostingRole } from './entities/account-mapping'
import { type AccountType, LedgerAccount } from './entities/ledger-account'
import { type Fact, type PlannedLine, planPosting } from './services/posting-rules'
import { AccountCode, AccountName, Currency } from './value-objects/ledger-values'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const tenantId = '0192a3b4-0000-7000-8000-0000000000ff'
const now = new Date('2026-09-16T12:00:00Z')
const brl = valid(Currency.create('BRL'))

function account(code: string, type: AccountType): LedgerAccount {
  return valid(
    LedgerAccount.open({
      tenantId,
      code: valid(AccountCode.create(code)),
      name: valid(AccountName.create(`Account ${code}`)),
      type,
      parent: null,
      postable: true,
      currency: brl,
      now,
    }),
  )
}

/** One account per part, so a plan can be read by the code it names. */
const ACCOUNTS: Readonly<Record<PostingRole, LedgerAccount>> = {
  receivables: account('1', 'asset'),
  cash: account('2', 'asset'),
  suspense: account('3', 'asset'),
  payables: account('4', 'liability'),
  'opening-balance': account('5', 'equity'),
  revenue: account('6', 'revenue'),
  'discount-received': account('7', 'revenue'),
  'financial-income': account('8', 'revenue'),
  expense: account('9', 'expense'),
  'discount-granted': account('10', 'expense'),
  'financial-expense': account('11', 'expense'),
  'bank-fees': account('12', 'expense'),
}

const CODES = new Map(
  Object.values(ACCOUNTS).map((entry) => [entry.id.toString(), entry.code] as const),
)

function chartOf(roles: readonly PostingRole[], extra: readonly AccountMapping[] = []) {
  const mappings = roles.map((role) =>
    valid(
      AccountMapping.define({
        tenantId,
        role,
        key: null,
        account: ACCOUNTS[role],
        actor: 'ana',
        now,
      }),
    ),
  )
  return new PostingChart([...mappings, ...extra])
}

const EVERY_ROLE = Object.keys(ACCOUNTS) as PostingRole[]
const full = () => chartOf(EVERY_ROLE)

/** A plan as `code side amount`, which is how an accountant would read it aloud. */
function readable(lines: readonly PlannedLine[]): string[] {
  return lines.map((line) => `${CODES.get(line.accountId)} ${line.side} ${line.amount}`)
}

function plan(fact: Fact, chart = full()) {
  return planPosting(fact, chart)
}

const title = (over: Partial<Extract<Fact, { kind: 'receivable' | 'payable' }>> = {}): Fact => ({
  kind: 'receivable',
  id: 'f1',
  reference: 'NF-1001',
  on: '2026-09-16',
  currency: 'BRL',
  categoryId: 'c1',
  total: 10_000n,
  ...over,
})

const settlement = (
  over: Partial<Extract<Fact, { kind: 'settlement' }>> = {},
): Extract<Fact, { kind: 'settlement' }> => ({
  kind: 'settlement',
  id: 's1',
  reference: 'NF-1001',
  on: '2026-09-20',
  currency: 'BRL',
  direction: 'receivable',
  treasuryAccountId: null,
  received: 10_000n,
  discount: 0n,
  interest: 0n,
  penalty: 0n,
  ...over,
})

/** Debits and credits of a plan, which the whole module exists to keep equal. */
function totals(lines: readonly PlannedLine[]) {
  const side = (which: 'debit' | 'credit') =>
    lines.reduce((sum, line) => (line.side === which ? sum + line.amount : sum), 0n)
  return { debits: side('debit'), credits: side('credit') }
}

describe('posting a title', () => {
  it('raises the claim against revenue, and the cost against the obligation', () => {
    expect(readable(valid(plan(title())).lines)).toEqual(['1 debit 10000', '6 credit 10000'])
    expect(readable(valid(plan(title({ kind: 'payable' }))).lines)).toEqual([
      '9 debit 10000',
      '4 credit 10000',
    ])
  })

  it('uses the account mapped for the category ahead of the workspace default', () => {
    const specific = valid(
      AccountMapping.define({
        tenantId,
        role: 'revenue',
        key: 'c1',
        account: ACCOUNTS['financial-income'],
        actor: 'ana',
        now,
      }),
    )
    const chart = chartOf(EVERY_ROLE, [specific])
    expect(readable(valid(plan(title(), chart)).lines)).toEqual(['1 debit 10000', '8 credit 10000'])
    // A category with no account of its own still posts, against the default.
    expect(readable(valid(plan(title({ categoryId: 'c2' }), chart)).lines)).toEqual([
      '1 debit 10000',
      '6 credit 10000',
    ])
  })

  it('falls back to suspense so the books stay complete, and names what is missing otherwise', () => {
    const onlySuspense = chartOf(['receivables', 'suspense'])
    expect(readable(valid(plan(title(), onlySuspense)).lines)).toEqual([
      '1 debit 10000',
      '3 credit 10000',
    ])
    const nothing = chartOf(['receivables'])
    const refused = plan(title(), nothing)
    expect(refused.isLeft() && refused.value.message).toMatch(/no account is mapped for: revenue/)
  })
})

describe('settling a title', () => {
  it('moves cash against the claim', () => {
    expect(readable(valid(plan(settlement())).lines)).toEqual(['2 debit 10000', '1 credit 10000'])
  })

  it('charges a discount and credits interest and penalty as income', () => {
    const lines = valid(plan(settlement({ received: 9_000n, discount: 1_000n }))).lines
    expect(readable(lines)).toEqual(['2 debit 9000', '10 debit 1000', '1 credit 10000'])

    const charged = valid(plan(settlement({ received: 10_500n, interest: 300n, penalty: 200n })))
    expect(readable(charged.lines)).toEqual(['2 debit 10500', '8 credit 500', '1 credit 10000'])
  })

  it('debits the claim when a settlement charges more than it collects', () => {
    // Ten in cash against five hundred of interest: the customer owes more, not less.
    const lines = valid(plan(settlement({ received: 10n, interest: 500n }))).lines
    expect(readable(lines)).toEqual(['2 debit 10', '8 credit 500', '1 debit 490'])
    expect(totals(lines)).toEqual({ debits: 500n, credits: 500n })
  })

  it('mirrors every rule for a payable', () => {
    const paid = valid(
      plan(settlement({ direction: 'payable', received: 9_000n, discount: 1_000n })),
    )
    expect(readable(paid.lines)).toEqual(['2 credit 9000', '7 credit 1000', '4 debit 10000'])
    const late = valid(
      plan(settlement({ direction: 'payable', received: 10_500n, interest: 500n })),
    )
    expect(readable(late.lines)).toEqual(['2 credit 10500', '11 debit 500', '4 debit 10000'])
  })

  it('uses the cash account mapped for the treasury account the money moved through', () => {
    const specific = valid(
      AccountMapping.define({
        tenantId,
        role: 'cash',
        key: 'bank-1',
        account: ACCOUNTS.receivables,
        actor: 'ana',
        now,
      }),
    )
    const chart = chartOf(EVERY_ROLE, [specific])
    const lines = valid(plan(settlement({ treasuryAccountId: 'bank-1' }), chart)).lines
    expect(readable(lines)).toEqual(['1 debit 10000', '1 credit 10000'])
  })
})

describe('a treasury movement', () => {
  const transfer = (fee: bigint): Fact => ({
    kind: 'transfer',
    id: 't1',
    reference: 'Transfer',
    on: '2026-09-18',
    currency: 'BRL',
    fromAccountId: 'a',
    toAccountId: 'b',
    amount: 50_000n,
    fee,
  })

  it('never touches profit or loss, though its fee does', () => {
    const plain = valid(plan(transfer(0n))).lines
    expect(readable(plain)).toEqual(['2 debit 50000', '2 credit 50000'])
    expect(plain.some((line) => CODES.get(line.accountId) === '12')).toBe(false)

    const charged = valid(plan(transfer(350n))).lines
    expect(readable(charged)).toEqual([
      '2 debit 50000',
      '2 credit 50000',
      '12 debit 350',
      '2 credit 350',
    ])
    expect(totals(charged)).toEqual({ debits: 50_350n, credits: 50_350n })
  })

  it('books an opening balance against equity and a manual entry into suspense', () => {
    const entry = (source: 'opening' | 'manual', direction: 'inflow' | 'outflow'): Fact => ({
      kind: 'treasury-entry',
      id: 'e1',
      reference: 'Entry',
      on: '2026-09-01',
      currency: 'BRL',
      accountId: 'a',
      source,
      direction,
      amount: 1_000n,
    })
    expect(readable(valid(plan(entry('opening', 'inflow'))).lines)).toEqual([
      '2 debit 1000',
      '5 credit 1000',
    ])
    expect(readable(valid(plan(entry('manual', 'outflow'))).lines)).toEqual([
      '2 credit 1000',
      '3 debit 1000',
    ])
  })
})

describe('every plan', () => {
  /** A deterministic generator, so a failing case can be reproduced from its seed. */
  function generator(seed: number) {
    let state = seed
    return (max: number) => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
      return state % max
    }
  }

  it('balances, whatever combination of cash, discount, interest and penalty arrives', () => {
    const next = generator(20260919)
    for (let run = 0; run < 500; run += 1) {
      const fact = settlement({
        direction: next(2) === 0 ? 'receivable' : 'payable',
        received: BigInt(next(20_000)),
        discount: BigInt(next(4) === 0 ? next(2_000) : 0),
        interest: BigInt(next(3) === 0 ? next(1_000) : 0),
        penalty: BigInt(next(5) === 0 ? next(500) : 0),
      })
      const planned = plan(fact)
      // Everything zero has nothing to post, which is a refusal rather than an empty entry.
      if (planned.isLeft()) {
        expect(planned.value.message).toMatch(/nothing to post/)
        continue
      }
      const { debits, credits } = totals(planned.value.lines)
      expect(debits).toBe(credits)
      expect(planned.value.lines.every((line) => line.amount > 0n)).toBe(true)
    }
  })
})

describe('an account mapping', () => {
  it('refuses an account of the wrong type, a parent account and a key where none belongs', () => {
    const define = (role: PostingRole, account: LedgerAccount, key: string | null = null) =>
      AccountMapping.define({ tenantId, role, key, account, actor: 'ana', now })
    expect(define('revenue', ACCOUNTS.receivables).isLeft()).toBe(true)
    expect(define('receivables', ACCOUNTS.payables).isLeft()).toBe(true)
    expect(define('receivables', ACCOUNTS.receivables, 'c1').isLeft()).toBe(true)
    const group = valid(
      LedgerAccount.open({
        tenantId,
        code: valid(AccountCode.create('20')),
        name: valid(AccountName.create('Group')),
        type: 'asset',
        parent: null,
        postable: false,
        currency: brl,
        now,
      }),
    )
    expect(define('receivables', group).isLeft()).toBe(true)
    expect(define('revenue', ACCOUNTS.revenue, 'c1').isRight()).toBe(true)
  })

  it('is repointed at another account without touching what it already caused', () => {
    const mapping = valid(
      AccountMapping.define({
        tenantId,
        role: 'revenue',
        key: null,
        account: ACCOUNTS.revenue,
        actor: 'ana',
        now,
      }),
    )
    expect(mapping.pointAt(ACCOUNTS.receivables, 'bruno', now).isLeft()).toBe(true)
    valid(mapping.pointAt(ACCOUNTS['financial-income'], 'bruno', now))
    expect(mapping.accountCode).toBe('8')
  })
})
