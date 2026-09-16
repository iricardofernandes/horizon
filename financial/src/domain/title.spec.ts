import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { Title, type TitleTerms } from './entities/title'
import { BusinessDate, Currency, Money, Share } from './value-objects/financial-values'
import { DocumentNumber, Reason } from './value-objects/title-values'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-16T12:00:00Z')
const brl = valid(Currency.create('BRL'))
const money = (amount: bigint | number) => Money.of(BigInt(amount), brl)
const date = (value: string) => valid(BusinessDate.create(value))
const reason = valid(Reason.create('Entered by mistake'))
const categoryId = '0192a3b4-0000-7000-8000-000000000001'

function terms(overrides: Partial<TitleTerms> = {}): TitleTerms {
  return {
    partyId: '0192a3b4-0000-7000-8000-0000000000aa',
    documentNumber: valid(DocumentNumber.create('NF-1001')),
    description: null,
    currency: brl,
    categoryId,
    issuedOn: date('2026-09-16'),
    competenceOn: date('2026-09-01'),
    installments: [
      { dueOn: date('2026-10-16'), amount: money(6000) },
      { dueOn: date('2026-11-15'), amount: money(4000) },
    ],
    allocations: [],
    ...overrides,
  }
}

function posted(overrides: Partial<TitleTerms> = {}): Title {
  const title = valid(
    Title.draft({
      tenantId: '0192a3b4-0000-7000-8000-0000000000ff',
      direction: 'receivable',
      origin: { type: 'manual' },
      terms: terms(overrides),
      now,
    }),
  )
  valid(title.post(now))
  title.pullDomainEvents()
  return title
}

const nothing = money(0)
const settlement = (
  installmentNumber: number,
  received: number,
  extra: Partial<Record<'discount' | 'interest' | 'penalty', number>> = {},
) => ({
  installmentNumber,
  settledOn: date('2026-10-01'),
  received: money(received),
  discount: money(extra.discount ?? 0),
  interest: money(extra.interest ?? 0),
  penalty: money(extra.penalty ?? 0),
  paymentMethodId: null,
})

describe('a receivable title', () => {
  it('numbers the schedule and refuses one that cannot be collected', () => {
    const draft = (overrides: Partial<TitleTerms>) =>
      Title.draft({
        tenantId: 't',
        direction: 'receivable',
        origin: { type: 'manual' },
        terms: terms(overrides),
        now,
      })
    expect(snapshotOf(valid(draft({}))).installments.map((row) => row.number)).toEqual([1, 2])
    expect(draft({ installments: [] }).isLeft()).toBe(true)
    expect(draft({ installments: [{ dueOn: date('2026-10-01'), amount: nothing }] }).isLeft()).toBe(
      true,
    )
    expect(
      draft({ installments: [{ dueOn: date('2026-09-15'), amount: money(1) }] }).isLeft(),
    ).toBe(true)
    expect(
      draft({
        installments: [
          { dueOn: date('2026-11-01'), amount: money(1) },
          { dueOn: date('2026-10-01'), amount: money(1) },
        ],
      }).isLeft(),
    ).toBe(true)
    expect(
      draft({
        allocations: [{ dimensionId: 'd', share: valid(Share.fromPercentage('60')) }],
      }).isLeft(),
    ).toBe(true)
  })

  it('may be revised and cancelled only while it is a draft', () => {
    const draft = valid(
      Title.draft({
        tenantId: 't',
        direction: 'receivable',
        origin: { type: 'manual' },
        terms: terms({ categoryId: null }),
        now,
      }),
    )
    expect(draft.post(now).isLeft()).toBe(true)
    valid(draft.revise(terms(), now))
    valid(draft.post(now))
    const [event] = draft.pullDomainEvents()
    expect(event?.eventType).toBe('financial.receivable.posted')
    expect(event?.payloadOf()).toMatchObject({ total: { amount: '10000', currency: 'BRL' } })
    expect(draft.revise(terms(), now).isLeft()).toBe(true)
    expect(draft.cancel(reason, now).isLeft()).toBe(true)
  })

  it('settles partially, then fully, with discount, interest and penalty', () => {
    const title = posted()
    valid(title.settle(settlement(1, 3000), now))
    expect(snapshotOf(title)).toMatchObject({
      outstanding: '7000',
      settlementState: 'partially-settled',
    })
    valid(title.settle(settlement(1, 3050, { discount: 100, interest: 100, penalty: 50 }), now))
    expect(snapshotOf(title).installments[0]).toMatchObject({ outstanding: '0', state: 'settled' })
    valid(title.settle(settlement(2, 4000), now))
    expect(snapshotOf(title)).toMatchObject({ outstanding: '0', settlementState: 'settled' })
    const events = title.pullDomainEvents()
    expect(events.map((event) => event.eventType)).toEqual([
      'financial.settlement.recorded',
      'financial.settlement.recorded',
      'financial.settlement.recorded',
    ])
    expect(events[2]?.payloadOf()).toMatchObject({ outstanding: { amount: '0' } })
  })

  it('refuses overpayment, empty settlements, foreign currency and unknown installments', () => {
    const title = posted()
    expect(title.settle(settlement(1, 6001), now).isLeft()).toBe(true)
    expect(title.settle(settlement(1, 0), now).isLeft()).toBe(true)
    expect(title.settle(settlement(3, 1), now).isLeft()).toBe(true)
    const usd = valid(Currency.create('USD'))
    expect(title.settle({ ...settlement(1, 1), received: Money.of(1n, usd) }, now).isLeft()).toBe(
      true,
    )
    expect(title.settle({ ...settlement(1, 1), settledOn: date('2026-09-01') }, now).isLeft()).toBe(
      true,
    )
  })

  it('cannot be reversed while a settlement is in force, and never edits one away', () => {
    const title = posted()
    const recorded = valid(title.settle(settlement(1, 6000), now))
    expect(title.reverse(reason, now).isLeft()).toBe(true)
    valid(title.reverseSettlement(recorded.id, reason, now))
    expect(title.reverseSettlement(recorded.id, reason, now).isLeft()).toBe(true)
    expect(snapshotOf(title)).toMatchObject({ outstanding: '10000', settlementState: 'open' })
    expect(snapshotOf(title).settlements).toHaveLength(1)
    valid(title.reverse(reason, now))
    expect(snapshotOf(title).status).toBe('reversed')
    expect(title.settle(settlement(1, 1), now).isLeft()).toBe(true)
    expect(title.pullDomainEvents().map((event) => event.eventType)).toEqual([
      'financial.settlement.recorded',
      'financial.settlement.reversed',
      'financial.receivable.reversed',
    ])
  })

  it('refuses a reversal that would push a balance below zero', () => {
    const title = posted()
    const charged = valid(title.settle(settlement(1, 10, { interest: 500 }), now))
    valid(title.settle(settlement(1, 6490), now))
    expect(title.reverseSettlement(charged.id, reason, now).isLeft()).toBe(true)
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

type Applied = { id: string; additions: bigint; reductions: bigint }
type Random = (max: number) => number

function randomTitle(next: Random): { title: Title; count: number } {
  const count = 1 + next(4)
  const title = posted({
    installments: Array.from({ length: count }, (_, index) => ({
      dueOn: date('2026-10-01').plusDays(index * 30),
      amount: money(1 + next(50_000)),
    })),
  })
  return { title, count }
}

/** Reverse a random settlement in force; returns it when the title accepted the reversal. */
function reverseRandom(title: Title, applied: Applied[], next: Random): Applied | null {
  const index = next(applied.length)
  const pick = applied[index]
  if (!pick || title.reverseSettlement(pick.id, reason, now).isLeft()) return null
  applied.splice(index, 1)
  return pick
}

function settleRandom(title: Title, count: number, next: Random): Applied | null {
  const interest = next(3) === 0 ? next(300) : 0
  const penalty = next(5) === 0 ? next(100) : 0
  const received = next(20_000)
  const discount = next(4) === 0 ? next(200) : 0
  const result = title.settle(
    settlement(1 + next(count), received, { discount, interest, penalty }),
    now,
  )
  if (result.isLeft()) return null
  return {
    id: result.value.id,
    additions: BigInt(interest + penalty),
    reductions: BigInt(received + discount),
  }
}

/** One random step: a reversal a quarter of the time, a settlement otherwise. Returns the balance change. */
function randomStep(title: Title, count: number, applied: Applied[], next: Random): bigint {
  if (applied.length > 0 && next(4) === 0) {
    const undone = reverseRandom(title, applied, next)
    return undone ? undone.reductions - undone.additions : 0n
  }
  const recorded = settleRandom(title, count, next)
  if (!recorded) return 0n
  applied.push(recorded)
  return recorded.additions - recorded.reductions
}

describe('the balance invariant', () => {
  it('always equals original plus additions minus reductions, across random histories', () => {
    const next = generator(20260917)
    for (let run = 0; run < 300; run += 1) {
      const { title, count } = randomTitle(next)
      let expected = BigInt(snapshotOf(title).total)
      const applied: Applied[] = []
      for (let step = 0; step < 25; step += 1) {
        expected += randomStep(title, count, applied, next)
        const snapshot = snapshotOf(title)
        const rows = snapshot.installments.map((row) => BigInt(row.outstanding))
        expect(BigInt(snapshot.outstanding)).toBe(expected)
        expect(rows.every((value) => value >= 0n)).toBe(true)
        expect(rows.reduce((sum, value) => sum + value, 0n)).toBe(expected)
      }
    }
  })
})
