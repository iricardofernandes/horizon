import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { Account } from './entities/account'
import { bookBalance, type EntryDirection, JournalEntry } from './entities/journal-entry'
import { Transfer } from './entities/transfer'
import { AccountName, BusinessDate, Currency, Money, Reason } from './value-objects/treasury-values'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-17T12:00:00Z')
const brl = valid(Currency.create('BRL'))
const money = (amount: number | bigint) => Money.of(BigInt(amount), brl)
const date = (value: string) => valid(BusinessDate.create(value))
const reason = valid(Reason.create('Recorded on the wrong account'))

function account(name: string, currency = brl) {
  return Account.open({
    tenantId: 't',
    kind: 'bank',
    name: valid(AccountName.create(name)),
    currency,
    bank: null,
    openedOn: date('2026-09-01'),
    now,
  })
}

function entry(accountId: string, direction: EntryDirection, amount: number, valueOn: string) {
  return valid(
    JournalEntry.record({
      tenantId: 't',
      accountId,
      direction,
      amount: money(amount),
      valueOn: date(valueOn),
      source: 'manual',
      transferId: null,
      settlementId: null,
      reverses: null,
      counterparty: null,
      memo: null,
      reason: null,
      now,
    }),
  )
}

describe('an account journal', () => {
  it('refuses entries on an inactive account, in another currency or before opening', () => {
    const checking = account('Checking')
    expect(checking.accepts(brl, date('2026-08-31')).isLeft()).toBe(true)
    expect(checking.accepts(valid(Currency.create('USD')), date('2026-09-02')).isLeft()).toBe(true)
    valid(checking.changeStatus(false, now))
    expect(checking.accepts(brl, date('2026-09-02')).isLeft()).toBe(true)
  })

  it('reverses a manual entry once, in the opposite direction, and never a reversal', () => {
    const line = entry('a', 'outflow', 1500, '2026-09-10')
    const inverse = valid(line.reverse(reason, now))
    expect(snapshotOf(inverse)).toMatchObject({
      direction: 'inflow',
      amount: '1500',
      valueOn: '2026-09-10',
      source: 'reversal',
      reverses: line.id.toString(),
      reason: 'Recorded on the wrong account',
    })
    expect(bookBalance([line, inverse])).toBe(0n)
    expect(inverse.reverse(reason, now).isLeft()).toBe(true)
  })
})

describe('a transfer', () => {
  it('moves money with both legs and a fee, and nets to zero once cancelled', () => {
    const from = account('Checking')
    const to = account('Savings')
    const { transfer, legs } = valid(
      Transfer.post({
        tenantId: 't',
        from,
        to,
        amount: money(10_000),
        fee: money(350),
        valueOn: date('2026-09-10'),
        memo: null,
        now,
      }),
    )
    const onAccount = (id: string, entries: readonly JournalEntry[]) =>
      bookBalance(entries.filter((candidate) => candidate.accountId === id))
    expect(legs.map((leg) => [leg.source, leg.direction])).toEqual([
      ['transfer', 'outflow'],
      ['transfer', 'inflow'],
      ['transfer-fee', 'outflow'],
    ])
    expect(onAccount(from.id.toString(), legs)).toBe(-10_350n)
    expect(onAccount(to.id.toString(), legs)).toBe(10_000n)
    expect(legs[0]?.reverse(reason, now).isLeft()).toBe(true)

    const inverses = valid(transfer.cancel(legs, reason, now))
    const all = [...legs, ...inverses]
    expect(onAccount(from.id.toString(), all)).toBe(0n)
    expect(onAccount(to.id.toString(), all)).toBe(0n)
    expect(snapshotOf(transfer)).toMatchObject({ status: 'cancelled' })
    expect(transfer.cancel(legs, reason, now).isLeft()).toBe(true)
    expect(transfer.pullDomainEvents().map((event) => event.eventType)).toEqual([
      'treasury.transfer.posted',
      'treasury.transfer.cancelled',
    ])
  })

  it('refuses the same account, a foreign currency, a zero amount and an inactive side', () => {
    const from = account('Checking')
    const post = (to: Account, amount = 100) =>
      Transfer.post({
        tenantId: 't',
        from,
        to,
        amount: money(amount),
        fee: null,
        valueOn: date('2026-09-10'),
        memo: null,
        now,
      })
    expect(post(from).isLeft()).toBe(true)
    expect(post(account('Dollars', valid(Currency.create('USD')))).isLeft()).toBe(true)
    expect(post(account('Savings'), 0).isLeft()).toBe(true)
    const closed = account('Closed')
    valid(closed.changeStatus(false, now))
    expect(post(closed).isLeft()).toBe(true)
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

/** The balance at the end of each value date, from entries in any recorded order. */
function dailyBalances(entries: readonly JournalEntry[]): Map<string, bigint> {
  const byDay = new Map<string, bigint>()
  for (const line of entries) {
    const day = snapshotOf(line).valueOn
    byDay.set(day, (byDay.get(day) ?? 0n) + line.effect())
  }
  let running = 0n
  const balances = new Map<string, bigint>()
  for (const day of [...byDay.keys()].sort()) {
    running += byDay.get(day) ?? 0n
    balances.set(day, running)
  }
  return balances
}

describe('the book balance', () => {
  it('equals the sum of the journal whatever order backdated entries arrive in', () => {
    const next = generator(20260917)
    for (let run = 0; run < 200; run += 1) {
      const entries = Array.from({ length: 1 + next(40) }, () =>
        entry(
          'a',
          next(2) === 0 ? 'inflow' : 'outflow',
          1 + next(100_000),
          `2026-09-${String(1 + next(28)).padStart(2, '0')}`,
        ),
      )
      const shuffled = [...entries].sort(() => next(3) - 1)
      const expected = entries.reduce((sum, line) => sum + line.effect(), 0n)
      expect(bookBalance(shuffled)).toBe(expected)
      const timeline = dailyBalances(shuffled)
      expect([...timeline.values()].at(-1)).toBe(expected)
      expect(dailyBalances(entries)).toEqual(timeline)
    }
  })
})
