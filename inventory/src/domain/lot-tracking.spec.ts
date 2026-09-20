import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { StockBalance } from './entities/stock-balance'
import { Currency, Money, Quantity } from './value-objects/inventory-values'
import type { MovementOrigin } from './value-objects/movement-origin'
import { ExpiryDate, type ItemTracking, LotCode } from './value-objects/tracking'

const now = new Date('2026-09-20T09:00:00.000Z')

function unwrap<E, T>(result: { isLeft(): boolean; isRight(): boolean; value: E | T }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

const quantity = (value: string) => unwrap(Quantity.create(value))
const brl = unwrap(Currency.create('BRL'))
const money = (amount: string) => unwrap(Money.create(amount, brl))
const code = (value: string) => unwrap(LotCode.create(value))
const day = (value: string) => unwrap(ExpiryDate.create(value))

const document = (): MovementOrigin => ({
  reason: 'transfer',
  document: { type: 'transfer', id: randomUUID() },
})

const BY_LOT: ItemTracking = { kind: 'lot', expiry: 'optional' }
const BY_LOT_DATED: ItemTracking = { kind: 'lot', expiry: 'required' }

const shelf = (tracking: ItemTracking = BY_LOT) =>
  StockBalance.open({
    tenantId: randomUUID(),
    itemId: randomUUID(),
    warehouseId: randomUUID(),
    tracking,
    now,
  })

/** A lot entering at a cost, which is the only way stock gets onto a tracked shelf. */
const receive = (
  balance: StockBalance,
  lot: string,
  amount: string,
  expiresOn: string | null = null,
) =>
  unwrap(
    balance.receive(quantity(amount), money('1000'), now, [
      {
        code: code(lot),
        expiresOn: expiresOn === null ? null : day(expiresOn),
        quantity: quantity(amount),
      },
    ]),
  )

const held = (balance: StockBalance) =>
  balance.lots().map((lot) => [lot.code.value, lot.onHand.toString()])

describe('a shelf that has to say which boxes it is holding', () => {
  it('refuses goods that do not say which lot they are', () => {
    const balance = shelf()

    const received = balance.receive(quantity('10'), money('1000'), now)

    expect(received.isLeft()).toBe(true)
  })

  it('refuses a lot named for an item nobody asked to identify', () => {
    const balance = StockBalance.open({
      tenantId: randomUUID(),
      itemId: randomUUID(),
      warehouseId: randomUUID(),
      now,
    })

    const received = balance.receive(quantity('10'), money('1000'), now, [
      { code: code('AB-1'), expiresOn: null, quantity: quantity('10') },
    ])

    expect(received.isLeft()).toBe(true)
  })

  it('refuses lots that do not add up to what moved', () => {
    const balance = shelf()

    const received = balance.receive(quantity('10'), money('1000'), now, [
      { code: code('AB-1'), expiresOn: null, quantity: quantity('7') },
    ])

    expect(received.isLeft()).toBe(true)
  })

  it('insists on a date when the workspace says every lot has one', () => {
    const balance = shelf(BY_LOT_DATED)

    const undated = balance.receive(quantity('10'), money('1000'), now, [
      { code: code('AB-1'), expiresOn: null, quantity: quantity('10') },
    ])

    expect(undated.isLeft()).toBe(true)
  })

  it('will not restate the date of a lot already on the shelf', () => {
    const balance = shelf()
    receive(balance, 'AB-1', '10', '2026-12-01')

    const again = balance.receive(quantity('5'), money('1000'), now, [
      { code: code('AB-1'), expiresOn: day('2027-01-01'), quantity: quantity('5') },
    ])

    expect(again.isLeft()).toBe(true)
  })

  it('adds a second delivery of the same code to the lot already here', () => {
    const balance = shelf()
    receive(balance, 'AB-1', '10', '2026-12-01')

    receive(balance, 'AB-1', '5', '2026-12-01')

    expect(held(balance)).toEqual([['AB-1', '15']])
  })
})

describe('the order boxes leave in', () => {
  it('sends the earliest date first, whatever order it arrived in', () => {
    const balance = shelf()
    receive(balance, 'LATE', '10', '2027-01-01')
    receive(balance, 'SOON', '10', '2026-11-01')
    unwrap(balance.hold(quantity('12'), now))

    const gone = unwrap(balance.ship(quantity('12'), now))

    expect(gone.map((lot) => [lot.code.value, lot.quantity.toString()])).toEqual([
      ['SOON', '10'],
      ['LATE', '2'],
    ])
  })

  it('keeps what has no date at all for last', () => {
    const balance = shelf()
    receive(balance, 'UNDATED', '10')
    receive(balance, 'DATED', '10', '2027-01-01')
    unwrap(balance.hold(quantity('4'), now))

    const gone = unwrap(balance.ship(quantity('4'), now))

    expect(gone.map((lot) => lot.code.value)).toEqual(['DATED'])
  })

  it('draws from the lots somebody named instead, when they named them', () => {
    const balance = shelf()
    receive(balance, 'SOON', '10', '2026-11-01')
    receive(balance, 'LATE', '10', '2027-01-01')

    unwrap(
      balance.transferOut(quantity('3'), document(), now, [
        { code: code('LATE'), quantity: quantity('3') },
      ]),
    )

    expect(held(balance)).toEqual([
      ['SOON', '10'],
      ['LATE', '7'],
    ])
  })
})

describe('stock that has gone off', () => {
  const expired = () => {
    const balance = shelf()
    receive(balance, 'GONE', '10', '2026-09-01')
    receive(balance, 'GOOD', '4', '2027-01-01')
    return balance
  }

  it('is still on the shelf but can be promised to nobody', () => {
    const balance = expired()

    expect(balance.onHand().toString()).toBe('14')
    expect(balance.sellable(now).toString()).toBe('4')
    expect(balance.available(now).toString()).toBe('4')
  })

  it('cannot be reserved past what is still good', () => {
    const balance = expired()

    expect(balance.hold(quantity('5'), now).isLeft()).toBe(true)
    expect(balance.hold(quantity('4'), now).isRight()).toBe(true)
  })

  it('is never picked for a customer, even for a promise made before it went off', () => {
    const balance = shelf()
    receive(balance, 'GONE', '10', '2026-09-01')
    // Promised in August, when the lot was still good, and shipped in September.
    unwrap(balance.hold(quantity('10'), new Date('2026-08-15T09:00:00.000Z')))

    // The answer to "we have nothing good to send" is to say so, not to send this.
    expect(balance.ship(quantity('1'), now).isLeft()).toBe(true)
  })

  it('is written off when somebody names it, which is what the reason is for', () => {
    const balance = expired()

    const gone = balance.adjustOut(quantity('10'), document(), now, [
      { code: code('GONE'), quantity: quantity('10') },
    ])

    expect(gone.isRight()).toBe(true)
    expect(held(balance)).toEqual([['GOOD', '4']])
  })

  it('counts as good for the whole of the day printed on it', () => {
    const balance = shelf()
    receive(balance, 'TODAY', '10', '2026-09-20')

    // Nobody throws out the milk at nine in the morning on the date stamped on the carton.
    expect(balance.sellable(now).toString()).toBe('10')
  })
})

describe('boxes moving between the company’s own warehouses', () => {
  it('arrive as the very same lots, with the dates they left carrying', () => {
    const source = shelf()
    receive(source, 'SOON', '6', '2026-11-01')
    receive(source, 'LATE', '6', '2027-01-01')
    const destination = shelf()
    const origin = document()

    const taken = unwrap(source.transferOut(quantity('8'), origin, now))
    unwrap(destination.transferIn(quantity('8'), taken.cost, origin, now, taken.drawn))

    expect(held(destination)).toEqual([
      ['SOON', '6'],
      ['LATE', '2'],
    ])
    expect(destination.lots()[0]?.expiresOn?.value).toBe('2026-11-01')
    // The company owns exactly what it owned a moment ago, in the same boxes.
    expect(source.onHand().plus(destination.onHand()).toString()).toBe('12')
  })

  it('leaves a lot that has run out behind rather than keeping an empty one', () => {
    const source = shelf()
    receive(source, 'ONLY', '5')

    unwrap(source.transferOut(quantity('5'), document(), now))

    expect(source.lots()).toHaveLength(0)
    expect(source.onHand().isZero()).toBe(true)
  })

  it('refuses to move more of a lot than that lot is holding', () => {
    const balance = shelf()
    receive(balance, 'AB-1', '5')

    const moved = balance.transferOut(quantity('5'), document(), now, [
      { code: code('AB-1'), quantity: quantity('9') },
    ])

    expect(moved.isLeft()).toBe(true)
  })
})

describe('what a movement says it touched', () => {
  it('names the lots it drew from, so the thread can be followed later', () => {
    const balance = shelf()
    receive(balance, 'SOON', '4', '2026-11-01')
    receive(balance, 'LATE', '4', '2027-01-01')
    balance.pullDomainEvents()
    unwrap(balance.hold(quantity('6'), now))

    unwrap(balance.ship(quantity('6'), now))

    const movement = balance.pullDomainEvents()[0]
    const touched = (
      movement as { movementOf(): { lots: readonly { code: LotCode }[] } }
    ).movementOf().lots
    expect(touched.map((lot) => lot.code.value)).toEqual(['SOON', 'LATE'])
  })
})
