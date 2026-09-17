import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { AccountingPeriod } from './entities/accounting-period'
import { type DraftLine, JournalTransaction } from './entities/journal-transaction'
import {
  type AccountType,
  balanceOf,
  type EntrySide,
  LedgerAccount,
  normalBalanceOf,
} from './entities/ledger-account'
import {
  AccountCode,
  AccountName,
  BusinessDate,
  Currency,
  Memo,
  Money,
  Period,
  Reason,
  Reference,
} from './value-objects/ledger-values'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const tenantId = '0192a3b4-0000-7000-8000-0000000000ff'
const now = new Date('2026-09-16T12:00:00Z')
const brl = valid(Currency.create('BRL'))
const usd = valid(Currency.create('USD'))
const money = (amount: number | bigint) => Money.of(BigInt(amount), brl)
const date = (value: string) => valid(BusinessDate.create(value))
const reason = valid(Reason.create('Posted to the wrong account'))
const reference = valid(Reference.create('NF-1001'))

function account(
  code: string,
  type: AccountType,
  options: { postable?: boolean; parent?: LedgerAccount; currency?: Currency } = {},
) {
  return LedgerAccount.open({
    tenantId,
    code: valid(AccountCode.create(code)),
    name: valid(AccountName.create(`Account ${code}`)),
    type,
    parent: options.parent ?? null,
    postable: options.postable ?? true,
    currency: options.currency ?? brl,
    now,
  })
}

/** A small chart: two groups that total their children, and the leaves that take lines. */
const assets = valid(account('1', 'asset', { postable: false }))
const expenses = valid(account('4', 'expense', { postable: false }))
const cash = valid(account('1.01', 'asset', { parent: assets }))
const revenue = valid(account('3', 'revenue'))

function line(target: LedgerAccount, side: EntrySide, amount: number): DraftLine {
  return {
    accountId: target.id.toString(),
    accountCode: target.code,
    side,
    amount: money(amount),
    memo: null,
  }
}

function post(lines: readonly DraftLine[], postedOn = '2026-09-16') {
  return JournalTransaction.post({
    tenantId,
    reference,
    postedOn: date(postedOn),
    currency: brl,
    source: { type: 'manual', id: null },
    memo: null,
    lines,
    now,
  })
}

describe('the chart of accounts', () => {
  it('files an account under the parent its own code names', () => {
    const group = valid(account('1.02', 'asset', { postable: false, parent: assets }))
    expect(snapshotOf(group)).toMatchObject({ code: '1.02', parentId: assets.id.toString() })
    const leaf = valid(account('1.02.001', 'asset', { parent: group }))
    expect(snapshotOf(leaf).parentId).toBe(group.id.toString())
    expect(leaf.pullDomainEvents().map((event) => event.eventType)).toEqual([
      'ledger.account.opened',
    ])
  })

  it('refuses a child of a postable account, of another type, of another currency or of another branch', () => {
    const group = valid(account('1.03', 'asset', { postable: false, parent: assets }))
    expect(account('1.01.001', 'asset', { parent: cash }).isLeft()).toBe(true)
    expect(account('1.03.001', 'expense', { parent: group }).isLeft()).toBe(true)
    expect(account('1.03.001', 'asset', { parent: group, currency: usd }).isLeft()).toBe(true)
    expect(account('2.01.001', 'asset', { parent: group }).isLeft()).toBe(true)
    expect(account('1.03.001.002', 'asset', { parent: group }).isLeft()).toBe(true)
  })

  it('refuses a top-level code with a parent, and a nested code without one', () => {
    expect(account('1.09', 'asset').isLeft()).toBe(true)
    const group = valid(account('1.04', 'asset', { postable: false, parent: assets }))
    expect(account('2', 'liability', { parent: group }).isLeft()).toBe(true)
  })

  it('knows which side increases it, and takes lines only while postable, active and in its currency', () => {
    expect(normalBalanceOf('asset')).toBe('debit')
    expect(normalBalanceOf('liability')).toBe('credit')
    expect(balanceOf('asset', 900n, 400n)).toBe(500n)
    expect(balanceOf('revenue', 400n, 900n)).toBe(500n)

    expect(assets.accepts(money(1)).isLeft()).toBe(true)
    expect(cash.accepts(Money.of(1n, usd)).isLeft()).toBe(true)
    valid(cash.accepts(money(1)))
    const closable = valid(account('4.09', 'expense', { parent: expenses }))
    valid(closable.changeStatus(false, now))
    expect(closable.accepts(money(1)).isLeft()).toBe(true)
    expect(closable.changeStatus(false, now).isLeft()).toBe(true)
  })
})

describe('a journal transaction', () => {
  it('numbers its lines, derives its period and totals one side', () => {
    const posted = valid(post([line(cash, 'debit', 10_000), line(revenue, 'credit', 10_000)]))
    expect(snapshotOf(posted)).toMatchObject({
      period: '2026-09',
      total: '10000',
      status: 'posted',
      reverses: null,
    })
    expect(snapshotOf(posted).lines.map((row) => row.lineNumber)).toEqual([1, 2])
    const [event] = posted.pullDomainEvents()
    expect(event?.eventType).toBe('ledger.transaction.posted')
    expect(event?.payloadOf()).toMatchObject({
      period: '2026-09',
      total: { amount: '10000', currency: 'BRL' },
    })
  })

  it('refuses lines that do not balance, a single line, a zero amount and a foreign currency', () => {
    expect(post([line(cash, 'debit', 10_000), line(revenue, 'credit', 9_999)]).isLeft()).toBe(true)
    expect(post([line(cash, 'debit', 1)]).isLeft()).toBe(true)
    expect(post([line(cash, 'debit', 0), line(revenue, 'credit', 0)]).isLeft()).toBe(true)
    expect(
      post([
        { ...line(cash, 'debit', 1), amount: Money.of(1n, usd) },
        line(revenue, 'credit', 1),
      ]).isLeft(),
    ).toBe(true)
    expect(post([line(cash, 'debit', 1), line(revenue, 'debit', 1)]).isLeft()).toBe(true)
  })

  it('splits one side across several accounts', () => {
    const fees = valid(account('4.01', 'expense', { parent: expenses }))
    const posted = valid(
      post([line(cash, 'debit', 9_700), line(fees, 'debit', 300), line(revenue, 'credit', 10_000)]),
    )
    expect(snapshotOf(posted).total).toBe('10000')
    expect(snapshotOf(posted).lines).toHaveLength(3)
  })

  it('is undone by a mirror, once, and the mirror is final', () => {
    const posted = valid(post([line(cash, 'debit', 10_000), line(revenue, 'credit', 10_000)]))
    posted.pullDomainEvents()
    const reversal = valid(posted.reverse(reason, now))
    expect(snapshotOf(reversal).lines.map((row) => row.side)).toEqual(['credit', 'debit'])
    expect(snapshotOf(reversal)).toMatchObject({
      total: '10000',
      reverses: posted.id.toString(),
    })
    expect(snapshotOf(posted)).toMatchObject({
      status: 'reversed',
      reversedBy: reversal.id.toString(),
      reversalReason: 'Posted to the wrong account',
    })
    expect(posted.pullDomainEvents().map((event) => event.eventType)).toEqual([
      'ledger.transaction.reversed',
    ])
    expect(posted.reverse(reason, now).isLeft()).toBe(true)
    expect(reversal.reverse(reason, now).isLeft()).toBe(true)
  })

  it('may date the mirror in a later month, which is then the month it belongs to', () => {
    const posted = valid(post([line(cash, 'debit', 500), line(revenue, 'credit', 500)]))
    const reversal = valid(posted.reverse(reason, now, { reversalOn: date('2026-10-02') }))
    expect(reversal.period).toBe('2026-10')
    expect(posted.period).toBe('2026-09')
  })
})

describe('an accounting period', () => {
  const september = valid(Period.create('2026-09'))

  it('is closed, reopened with a reason, and closed again', () => {
    const closure = AccountingPeriod.close({ tenantId, period: september, actor: 'ana', now })
    expect(closure.isClosed()).toBe(true)
    expect(closure.pullDomainEvents().map((event) => event.eventType)).toEqual([
      'ledger.period.closed',
    ])
    expect(closure.closeAgain('ana', now).isLeft()).toBe(true)
    valid(closure.reopen('bruno', reason, now))
    expect(snapshotOf(closure)).toMatchObject({
      status: 'open',
      reopenedBy: 'bruno',
      reopenReason: 'Posted to the wrong account',
    })
    expect(closure.reopen('bruno', reason, now).isLeft()).toBe(true)
    valid(closure.closeAgain('ana', now))
    expect(snapshotOf(closure)).toMatchObject({ status: 'closed', reopenedBy: null })
    expect(closure.pullDomainEvents().map((event) => event.eventType)).toEqual([
      'ledger.period.reopened',
      'ledger.period.closed',
    ])
  })

  it('takes its month from the date a transaction was posted on', () => {
    expect(Period.of(date('2026-01-31')).value).toBe('2026-01')
    expect(Period.create('2026-13').isLeft()).toBe(true)
    expect(Period.create('2026-1').isLeft()).toBe(true)
  })
})

describe('value objects', () => {
  it('reads a dotted code as a place in the tree', () => {
    const parent = valid(AccountCode.create('1.01'))
    expect(parent.depth).toBe(2)
    expect(valid(AccountCode.create('1.01.001')).isChildOf(parent)).toBe(true)
    expect(valid(AccountCode.create('1.01.001.002')).isChildOf(parent)).toBe(false)
    expect(valid(AccountCode.create('1.02')).isChildOf(parent)).toBe(false)
    expect(AccountCode.create('1.0100').isLeft()).toBe(true)
    expect(AccountCode.create('1.a').isLeft()).toBe(true)
  })

  it('keeps optional text optional and required text required', () => {
    expect(valid(Memo.create(undefined, '/memo'))).toBeNull()
    expect(valid(Memo.create('  ', '/memo'))).toBeNull()
    expect(valid(Memo.create('  paid   in full ', '/memo'))?.value).toBe('paid in full')
    expect(Reason.create('no').isLeft()).toBe(true)
    expect(Reference.create('').isLeft()).toBe(true)
  })
})

/** A deterministic generator, so a failing case can be reproduced from its seed. */
function generator(seed: number) {
  let state = seed
  return (max: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state % max
  }
}

const chart = [
  cash,
  valid(account('2', 'liability')),
  revenue,
  valid(account('4.02', 'expense', { parent: expenses })),
  valid(account('5', 'equity')),
]

/** A random transaction: one side split across accounts, the other taking the whole amount. */
function randomTransaction(next: (max: number) => number) {
  const splits = 1 + next(3)
  const amounts = Array.from({ length: splits }, () => 1 + next(50_000))
  const total = amounts.reduce((sum, value) => sum + value, 0)
  const debitFirst = next(2) === 0
  const lines: DraftLine[] = amounts.map((amount) => {
    const target = chart[next(chart.length)]
    if (!target) throw new Error('the chart is never empty')
    return line(target, debitFirst ? 'debit' : 'credit', amount)
  })
  const other = chart[next(chart.length)]
  if (!other) throw new Error('the chart is never empty')
  lines.push(line(other, debitFirst ? 'credit' : 'debit', total))
  return post(lines, `2026-0${1 + next(9)}-1${next(9)}`)
}

describe('the double-entry invariant', () => {
  it('leaves every posting, and every reversal, with debits equal to credits', () => {
    const next = generator(20260918)
    const tally = new Map<string, bigint>()
    const apply = (transaction: JournalTransaction) => {
      for (const row of snapshotOf(transaction).lines) {
        const signed = row.side === 'debit' ? BigInt(row.amount) : -BigInt(row.amount)
        tally.set(row.accountId, (tally.get(row.accountId) ?? 0n) + signed)
      }
    }
    for (let run = 0; run < 400; run += 1) {
      const posted = randomTransaction(next)
      if (posted.isLeft()) continue
      apply(posted.value)
      const snapshot = snapshotOf(posted.value)
      const debits = snapshot.lines
        .filter((row) => row.side === 'debit')
        .reduce((sum, row) => sum + BigInt(row.amount), 0n)
      const credits = snapshot.lines
        .filter((row) => row.side === 'credit')
        .reduce((sum, row) => sum + BigInt(row.amount), 0n)
      expect(debits).toBe(credits)
      expect(BigInt(snapshot.total)).toBe(debits)
      if (next(3) === 0) {
        const reversal = posted.value.reverse(reason, now)
        if (reversal.isRight()) apply(reversal.value)
      }
      // Across the whole chart, debits and credits cancel out after every step.
      expect([...tally.values()].reduce((sum, value) => sum + value, 0n)).toBe(0n)
    }
  })
})
