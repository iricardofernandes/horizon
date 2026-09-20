import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { StockAdjustment } from './entities/stock-adjustment'
import { StockBalance } from './entities/stock-balance'
import { StockCount } from './entities/stock-count'
import { StockTransfer } from './entities/stock-transfer'
import { Currency, Money, Note, Quantity } from './value-objects/inventory-values'
import type { MovementOrigin } from './value-objects/movement-origin'

const now = new Date('2026-09-19T12:00:00.000Z')
const later = new Date('2026-09-19T18:00:00.000Z')

function unwrap<E, T>(result: { isLeft(): boolean; isRight(): boolean; value: E | T }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

const quantity = (value: string) => unwrap(Quantity.create(value))
const brl = unwrap(Currency.create('BRL'))
const money = (amount: string) => unwrap(Money.create(amount, brl))
const note = (value: string) => unwrap(Note.create(value))

const origin = (type: 'transfer' | 'adjustment' | 'count'): MovementOrigin => ({
  reason: type === 'transfer' ? 'transfer' : type === 'count' ? 'count' : 'correction',
  document: { type, id: randomUUID() },
})

function opened(onHand: string, unitCost: string | null): StockBalance {
  const balance = StockBalance.open({
    tenantId: randomUUID(),
    itemId: randomUUID(),
    warehouseId: randomUUID(),
    now,
  })
  if (unitCost === null) {
    unwrap(balance.adjustIn(quantity(onHand), null, origin('count'), now))
    return balance
  }
  unwrap(balance.receive(quantity(onHand), money(unitCost), now))
  return balance
}

describe('a stock balance moved by hand', () => {
  it('sends goods out at what they are worth and takes them in at the same figure', () => {
    const source = opened('100', '1000')
    const destination = opened('10', '2000')
    const document = origin('transfer')

    const taken = unwrap(source.transferOut(quantity('40'), document, now))
    expect(taken.cost?.amount).toBe(1000n)
    unwrap(destination.transferIn(quantity('40'), taken.cost, document, now))

    expect(source.onHand().toString()).toBe('60')
    expect(destination.onHand().toString()).toBe('50')
    // 10 at 20.00 plus 40 at 10.00 is 600.00 over 50 units: 12.00 each.
    expect(destination.unitCost()?.amount).toBe(1200n)
  })

  it('keeps reserved goods where the order expects to find them', () => {
    const balance = opened('10', '1000')
    unwrap(balance.hold(quantity('8'), now))

    expect(balance.transferOut(quantity('3'), origin('transfer'), now).isLeft()).toBe(true)
    expect(balance.adjustOut(quantity('3'), origin('adjustment'), now).isLeft()).toBe(true)
    unwrap(balance.adjustOut(quantity('2'), origin('adjustment'), now))
    expect(balance.onHand().toString()).toBe('8')
  })

  it('will not let an adjustment re-price stock that already has a cost', () => {
    const balance = opened('10', '1000')
    expect(balance.adjustIn(quantity('1'), money('9999'), origin('adjustment'), now).isLeft()).toBe(
      true,
    )
    unwrap(balance.adjustIn(quantity('10'), null, origin('adjustment'), now))
    // Twenty units still worth ten reais each: an adjustment moved no value.
    expect(balance.unitCost()?.amount).toBe(1000n)
  })

  it('brings in goods nobody can price, at no cost, until something prices them', () => {
    const balance = opened('5', null)
    expect(balance.onHand().toString()).toBe('5')
    expect(balance.unitCost()).toBeNull()

    unwrap(balance.receive(quantity('5'), money('400'), now))
    // The five that were found are priced by the five that arrived: 20.00 over ten units.
    expect(balance.unitCost()?.amount).toBe(200n)
  })

  it('refuses a movement of nothing', () => {
    const balance = opened('5', '1000')
    const zero = quantity('0')
    expect(balance.transferOut(zero, origin('transfer'), now).isLeft()).toBe(true)
    expect(balance.adjustOut(zero, origin('adjustment'), now).isLeft()).toBe(true)
    expect(balance.transferIn(zero, null, origin('transfer'), now).isLeft()).toBe(true)
  })
})

describe('a transfer', () => {
  const post = (overrides: Partial<Parameters<typeof StockTransfer.post>[0]> = {}) =>
    StockTransfer.post({
      tenantId: randomUUID(),
      sourceWarehouseId: 'main',
      destinationWarehouseId: 'annex',
      lines: [{ itemId: 'item-a', quantity: quantity('1') }],
      note: note('rebalancing'),
      movedBy: 'keeper',
      now,
      ...overrides,
    })

  it('needs two warehouses, at least one line, and each item only once', () => {
    expect(post({ destinationWarehouseId: 'main' }).isLeft()).toBe(true)
    expect(post({ lines: [] }).isLeft()).toBe(true)
    expect(post({ lines: [{ itemId: 'item-a', quantity: quantity('0') }] }).isLeft()).toBe(true)
    expect(
      post({
        lines: [
          { itemId: 'item-a', quantity: quantity('1') },
          { itemId: 'item-a', quantity: quantity('2') },
        ],
      }).isLeft(),
    ).toBe(true)
  })

  it('records what moved and where', () => {
    const transfer = unwrap(post())
    expect(transfer.source()).toBe('main')
    expect(transfer.destination()).toBe('annex')
    expect(transfer.lines().map((line) => [line.itemId, line.quantity.toString()])).toEqual([
      ['item-a', '1'],
    ])
  })
})

describe('an adjustment', () => {
  const request = (overrides: Partial<Parameters<typeof StockAdjustment.request>[0]> = {}) =>
    StockAdjustment.request({
      tenantId: randomUUID(),
      warehouseId: randomUUID(),
      itemId: randomUUID(),
      direction: 'out',
      quantity: quantity('3'),
      reason: 'breakage',
      note: null,
      statedUnitCost: null,
      value: money('3000'),
      approvalRequired: true,
      requestedBy: 'keeper',
      now,
      ...overrides,
    })

  it('refuses a reason that does not work in the direction asked for', () => {
    expect(request({ direction: 'in', reason: 'breakage' }).isLeft()).toBe(true)
    expect(request({ direction: 'out', reason: 'found' }).isLeft()).toBe(true)
    expect(request({ direction: 'in', reason: 'correction' }).isRight()).toBe(true)
    expect(request({ direction: 'out', reason: 'correction' }).isRight()).toBe(true)
  })

  it('refuses an adjustment of nothing', () => {
    expect(request({ quantity: quantity('0') }).isLeft()).toBe(true)
  })

  it('posts straight away when no allowance stands in the way', () => {
    const adjustment = unwrap(request({ approvalRequired: false }))
    expect(adjustment.posts()).toBe(true)
    expect(adjustment.approvalState()).toBe('not-required')
    expect(adjustment.status()).toBe('posted')
    expect(adjustment.value()?.amount).toBe(3000n)
  })

  it('is neither allowed nor refused by the person who asked', () => {
    const adjustment = unwrap(request())
    expect(adjustment.approve('keeper', later).isLeft()).toBe(true)
    expect(adjustment.reject('keeper', note('no'), later).isLeft()).toBe(true)
    expect(adjustment.posts()).toBe(false)
  })

  it('is decided once', () => {
    const adjustment = unwrap(request())
    unwrap(adjustment.reject('manager', note('count it again first'), later))
    expect(adjustment.status()).toBe('rejected')
    expect(adjustment.posts()).toBe(false)
    expect(adjustment.approve('manager', later).isLeft()).toBe(true)
    expect(adjustment.approvalState()).toBe('rejected')
  })
})

describe('a count sheet', () => {
  const open = (lines = [{ itemId: 'item-a', expected: quantity('100') }]) =>
    unwrap(
      StockCount.open({
        tenantId: randomUUID(),
        warehouseId: randomUUID(),
        lines,
        note: null,
        openedBy: 'keeper',
        now,
      }),
    )

  it('needs something on it, and each item only once', () => {
    expect(
      StockCount.open({
        tenantId: randomUUID(),
        warehouseId: randomUUID(),
        lines: [],
        note: null,
        openedBy: 'keeper',
        now,
      }).isLeft(),
    ).toBe(true)
    expect(
      StockCount.open({
        tenantId: randomUUID(),
        warehouseId: randomUUID(),
        lines: [
          { itemId: 'item-a', expected: quantity('1') },
          { itemId: 'item-a', expected: quantity('2') },
        ],
        note: null,
        openedBy: 'keeper',
        now,
      }).isLeft(),
    ).toBe(true)
  })

  it('reports the difference between what it froze and what was counted', () => {
    const count = open([
      { itemId: 'short', expected: quantity('100') },
      { itemId: 'over', expected: quantity('10') },
      { itemId: 'exact', expected: quantity('5') },
      { itemId: 'untouched', expected: quantity('7') },
    ])
    unwrap(
      count.record(
        [
          { itemId: 'short', counted: quantity('98') },
          { itemId: 'over', counted: quantity('14') },
          { itemId: 'exact', counted: quantity('5') },
        ],
        later,
      ),
    )

    expect(count.variances()).toEqual([
      { itemId: 'short', direction: 'out', quantity: quantity('2') },
      { itemId: 'over', direction: 'in', quantity: quantity('4') },
    ])
  })

  it('takes figures only for items on it, and only while it is open', () => {
    const count = open()
    expect(count.record([{ itemId: 'elsewhere', counted: quantity('1') }], later).isLeft()).toBe(
      true,
    )
    expect(count.record([], later).isLeft()).toBe(true)
    expect(count.close('keeper', later, { approvalRequired: false }).isLeft()).toBe(true)

    unwrap(count.record([{ itemId: 'item-a', counted: quantity('99') }], later))
    unwrap(count.close('keeper', later, { approvalRequired: false }))
    expect(count.posts()).toBe(true)
    expect(count.record([{ itemId: 'item-a', counted: quantity('1') }], later).isLeft()).toBe(true)
    expect(count.close('keeper', later, { approvalRequired: false }).isLeft()).toBe(true)
  })

  it('does not let the person who closed it allow its own differences', () => {
    const count = open()
    unwrap(count.record([{ itemId: 'item-a', counted: quantity('40') }], later))
    unwrap(count.close('keeper', later, { approvalRequired: true }))
    expect(count.posts()).toBe(false)
    expect(count.approve('keeper', later).isLeft()).toBe(true)
    expect(count.reject('keeper', note('no'), later).isLeft()).toBe(true)

    unwrap(count.approve('manager', later))
    expect(count.posts()).toBe(true)
    expect(count.approve('manager', later).isLeft()).toBe(true)
  })

  it('can be abandoned while it is open or waiting, and never after', () => {
    const abandoned = open()
    unwrap(abandoned.cancel(note('the aisle was being restocked'), later))
    expect(abandoned.posts()).toBe(false)
    expect(abandoned.status()).toBe('cancelled')

    const settled = open()
    unwrap(settled.record([{ itemId: 'item-a', counted: quantity('100') }], later))
    unwrap(settled.close('keeper', later, { approvalRequired: false }))
    expect(settled.cancel(note('too late'), later).isLeft()).toBe(true)
  })

  it('keeps the approval it was waiting for when it is abandoned', () => {
    const count = open()
    unwrap(count.record([{ itemId: 'item-a', counted: quantity('1') }], later))
    unwrap(count.close('keeper', later, { approvalRequired: true }))
    unwrap(count.cancel(note('never mind'), later))
    // Nobody decided; calling that "not required" would claim the control was never there.
    expect(count.approvalState()).toBe('pending')
  })
})
