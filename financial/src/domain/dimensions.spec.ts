import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { FinancialCategory, MAX_CATEGORY_DEPTH } from './entities/financial-category'
import { PaymentTerm } from './entities/payment-term'
import { Allocation } from './value-objects/allocation'
import {
  BusinessDate,
  Code,
  Currency,
  Money,
  Name,
  Share,
  WHOLE,
} from './value-objects/financial-values'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-16T12:00:00Z')
const brl = valid(Currency.create('BRL'))
const share = (percentage: string) => valid(Share.fromPercentage(percentage))
const money = (amount: bigint) => Money.of(amount, brl)

/** A deterministic generator, so a failing case can be reproduced from its seed. */
function generator(seed: number) {
  let state = seed
  return (max: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state % max
  }
}

/** Random shares in basis points that add up to exactly 100%. */
function sharesOf(next: (max: number) => number, count: number): Share[] {
  const cuts = new Set<number>()
  while (cuts.size < count - 1) cuts.add(1 + next(WHOLE - 1))
  const points = [0, ...[...cuts].sort((a, b) => a - b), WHOLE]
  return points
    .slice(1)
    .map((point, index) => valid(Share.fromBasisPoints(point - (points[index] ?? 0))))
}

describe('money allocation', () => {
  it('never loses or invents a minor unit, across a thousand random splits', () => {
    const next = generator(20260916)
    for (let run = 0; run < 1000; run += 1) {
      const total = BigInt(next(10_000_000))
      const shares = sharesOf(next, 1 + next(12))
      const parts = money(total).allocate(shares)
      expect(parts.reduce((sum, part) => sum + part.amount, 0n)).toBe(total)
      for (const [index, part] of parts.entries()) {
        const exact = (total * BigInt(shares[index]?.basisPoints ?? 0)) / BigInt(WHOLE)
        expect(part.amount - exact <= 1n && part.amount >= exact).toBe(true)
      }
    }
  })

  it('gives the leftover cent to the largest remainder, earliest first on a tie', () => {
    const thirds = [share('33.34'), share('33.33'), share('33.33')]
    expect(
      money(100n)
        .allocate(thirds)
        .map((part) => part.amount),
    ).toEqual([34n, 33n, 33n])
    const halves = [share('50'), share('50')]
    expect(
      money(101n)
        .allocate(halves)
        .map((part) => part.amount),
    ).toEqual([51n, 50n])
  })
})

describe('shares and dates', () => {
  it('reads percentages with up to two decimals as exact basis points', () => {
    expect(share('33.33').basisPoints).toBe(3333)
    expect(share('7.5').basisPoints).toBe(750)
    expect(share('100').toPercentage()).toBe('100')
    expect(share('12.5').toPercentage()).toBe('12.5')
    for (const invalid of ['0', '100.01', '-1', '1.234', 'abc'])
      expect(Share.fromPercentage(invalid).isLeft()).toBe(true)
  })

  it('treats business dates as calendar dates, including leap years', () => {
    expect(valid(BusinessDate.create('2028-02-28')).plusDays(1).value).toBe('2028-02-29')
    expect(valid(BusinessDate.create('2026-01-31')).plusDays(30).value).toBe('2026-03-02')
    expect(BusinessDate.create('2026-02-30').isLeft()).toBe(true)
    expect(BusinessDate.create('16/09/2026').isLeft()).toBe(true)
  })
})

describe('payment terms', () => {
  const define = (installments: { dueInDays: number; share: Share }[]) =>
    PaymentTerm.define({
      tenantId: 'tenant',
      name: valid(Name.create('30/60/90')),
      installments,
      now,
    })

  it('schedules installments that add up to the total and fall due on calendar dates', () => {
    const term = valid(
      define([
        { dueInDays: 30, share: share('33.34') },
        { dueInDays: 60, share: share('33.33') },
        { dueInDays: 90, share: share('33.33') },
      ]),
    )
    const schedule = term.schedule(money(100_000n), valid(BusinessDate.create('2026-09-16')))
    expect(
      schedule.map((installment) => [installment.dueOn.value, installment.amount.amount]),
    ).toEqual([
      ['2026-10-16', 33_340n],
      ['2026-11-15', 33_330n],
      ['2026-12-15', 33_330n],
    ])
  })

  it('refuses shares that do not add up to exactly 100%', () => {
    expect(define([{ dueInDays: 30, share: share('99.99') }]).isLeft()).toBe(true)
  })

  it('refuses an installment that falls due before the one preceding it', () => {
    expect(
      define([
        { dueInDays: 60, share: share('50') },
        { dueInDays: 30, share: share('50') },
      ]).isLeft(),
    ).toBe(true)
  })
})

describe('allocations', () => {
  it('requires exactly 100% and each dimension once', () => {
    expect(
      Allocation.of([
        { dimensionId: 'a', share: share('60') },
        { dimensionId: 'b', share: share('30') },
      ]).isLeft(),
    ).toBe(true)
    expect(
      Allocation.of([
        { dimensionId: 'a', share: share('50') },
        { dimensionId: 'a', share: share('50') },
      ]).isLeft(),
    ).toBe(true)
  })

  it('splits an amount so the parts add up to the whole', () => {
    const allocation = valid(
      Allocation.of([
        { dimensionId: 'sales', share: share('70') },
        { dimensionId: 'marketing', share: share('30') },
      ]),
    )
    expect(allocation.split(money(999n)).map((part) => part.amount.amount)).toEqual([699n, 300n])
  })
})

describe('category tree', () => {
  const category = (
    codeValue: string,
    nature: 'revenue' | 'expense',
    parent: FinancialCategory | null,
  ) =>
    FinancialCategory.define(
      {
        tenantId: 'tenant',
        code: valid(Code.create(codeValue)),
        name: valid(Name.create(`Category ${codeValue}`)),
        nature,
        now,
      },
      parent,
    )

  it('keeps a child under a parent of the same nature', () => {
    const revenue = valid(category('1', 'revenue', null))
    expect(category('1.01', 'revenue', revenue).isRight()).toBe(true)
    expect(category('1.02', 'expense', revenue).isLeft()).toBe(true)
  })

  it(`stops at ${MAX_CATEGORY_DEPTH} levels`, () => {
    let parent = valid(category('1', 'expense', null))
    for (let depth = 2; depth <= MAX_CATEGORY_DEPTH; depth += 1)
      parent = valid(category(`1.${depth}`, 'expense', parent))
    expect(category('1.9', 'expense', parent).isLeft()).toBe(true)
  })

  it('refuses an inactive parent', () => {
    const parent = valid(category('2', 'expense', null))
    parent.changeStatus(false, now)
    expect(category('2.01', 'expense', parent).isLeft()).toBe(true)
  })
})
