import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { StockBalance } from './entities/stock-balance'
import { ofLots, ofSerials, pickSerials } from './entities/tracked-units'
import { Currency, Money, Quantity } from './value-objects/inventory-values'
import type { MovementOrigin } from './value-objects/movement-origin'
import { type ItemTracking, LotCode, SerialNumber } from './value-objects/tracking'

const now = new Date('2026-09-20T09:00:00.000Z')
const later = new Date('2026-09-21T09:00:00.000Z')

function unwrap<E, T>(result: { isLeft(): boolean; isRight(): boolean; value: E | T }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

const quantity = (value: string) => unwrap(Quantity.create(value))
const brl = unwrap(Currency.create('BRL'))
const money = (amount: string) => unwrap(Money.create(amount, brl))
const unit = (value: string) => unwrap(SerialNumber.create(value))
const units = (...values: string[]) => values.map(unit)

const document = (): MovementOrigin => ({
  reason: 'transfer',
  document: { type: 'transfer', id: randomUUID() },
})

const BY_UNIT: ItemTracking = { kind: 'serial', expiry: 'none' }

const shelf = (tracking: ItemTracking = BY_UNIT) =>
  StockBalance.open({
    tenantId: randomUUID(),
    itemId: randomUUID(),
    warehouseId: randomUUID(),
    tracking,
    now,
  })

const receive = (balance: StockBalance, serials: readonly string[], when = now) =>
  unwrap(
    balance.receive(
      quantity(String(serials.length)),
      money('1000'),
      when,
      ofSerials(serials.map(unit)),
    ),
  )

const held = (balance: StockBalance) => balance.serials().map((one) => one.serial.value)

describe('a shelf that holds units by name', () => {
  it('refuses goods that do not say which units they are', () => {
    const balance = shelf()

    expect(balance.receive(quantity('2'), money('1000'), now).isLeft()).toBe(true)
  })

  it('refuses a lot named for an item identified one unit at a time', () => {
    const balance = shelf()

    const received = balance.receive(
      quantity('2'),
      money('1000'),
      now,
      ofLots([{ code: unwrap(LotCode.create('AB-1')), expiresOn: null, quantity: quantity('2') }]),
    )

    expect(received.isLeft()).toBe(true)
  })

  it('refuses a name it is already holding', () => {
    const balance = shelf()
    receive(balance, ['SN-1'])

    const again = balance.receive(quantity('1'), money('1000'), now, ofSerials(units('SN-1')))

    expect(again.isLeft()).toBe(true)
  })

  it('refuses the same name twice in one delivery', () => {
    const balance = shelf()

    const received = balance.receive(
      quantity('2'),
      money('1000'),
      now,
      ofSerials(units('SN-1', 'SN-1')),
    )

    expect(received.isLeft()).toBe(true)
  })

  it('counts a unit as one, so the quantity can never disagree with the names', () => {
    const balance = shelf()

    const mismatched = balance.receive(
      quantity('3'),
      money('1000'),
      now,
      ofSerials(units('SN-1', 'SN-2')),
    )

    expect(mismatched.isLeft()).toBe(true)
    receive(balance, ['SN-1', 'SN-2'])
    expect(balance.onHand().toString()).toBe('2')
  })

  it('refuses to move a fraction of something that has a name', () => {
    const balance = shelf()
    receive(balance, ['SN-1'])
    unwrap(balance.hold(quantity('0.5'), now))

    expect(balance.ship(quantity('0.5'), now).isLeft()).toBe(true)
  })
})

describe('the order units leave in', () => {
  it('sends what has been sitting here longest', () => {
    const balance = shelf()
    receive(balance, ['SN-OLD'], now)
    receive(balance, ['SN-NEW'], later)
    unwrap(balance.hold(quantity('1'), later))

    const gone = unwrap(balance.ship(quantity('1'), later))

    expect(gone.serials.map((one) => one.value)).toEqual(['SN-OLD'])
    expect(held(balance)).toEqual(['SN-NEW'])
  })

  it('sends the very units somebody scanned, when they scanned them', () => {
    const balance = shelf()
    receive(balance, ['SN-1', 'SN-2', 'SN-3'])
    unwrap(balance.hold(quantity('1'), now))

    const gone = unwrap(balance.ship(quantity('1'), now, pickSerials(units('SN-3'))))

    expect(gone.serials.map((one) => one.value)).toEqual(['SN-3'])
    expect(held(balance)).toEqual(['SN-1', 'SN-2'])
  })

  it('refuses a unit that is not on this shelf', () => {
    const balance = shelf()
    receive(balance, ['SN-1'])

    const moved = balance.transferOut(quantity('1'), document(), now, pickSerials(units('SN-9')))

    expect(moved.isLeft()).toBe(true)
  })

  it('refuses more units than the quantity being moved', () => {
    const balance = shelf()
    receive(balance, ['SN-1', 'SN-2'])

    const moved = balance.transferOut(
      quantity('1'),
      document(),
      now,
      pickSerials(units('SN-1', 'SN-2')),
    )

    expect(moved.isLeft()).toBe(true)
  })
})

describe('units moving between the company’s own warehouses', () => {
  it('arrive as the very same units', () => {
    const source = shelf()
    receive(source, ['SN-1', 'SN-2', 'SN-3'])
    const destination = shelf()
    const origin = document()

    const taken = unwrap(source.transferOut(quantity('2'), origin, now))
    unwrap(destination.transferIn(quantity('2'), taken.cost, origin, now, taken.drawn))

    expect(held(source)).toEqual(['SN-3'])
    expect(held(destination)).toEqual(['SN-1', 'SN-2'])
  })
})

describe('what a movement says it touched', () => {
  it('names the units it drew, so one machine can be followed on its own', () => {
    const balance = shelf()
    receive(balance, ['SN-1', 'SN-2'])
    balance.pullDomainEvents()
    unwrap(balance.hold(quantity('1'), now))

    unwrap(balance.ship(quantity('1'), now))

    const movement = balance.pullDomainEvents()[0]
    const touched = (
      movement as { movementOf(): { units: { serials: readonly SerialNumber[] } } }
    ).movementOf().units.serials
    expect(touched.map((one) => one.value)).toEqual(['SN-1'])
  })
})

describe('a name that outlives the unit leaving', () => {
  it('lets the same unit come back to the shelf it was shipped from', () => {
    const balance = shelf()
    receive(balance, ['SN-1', 'SN-2'])
    unwrap(balance.hold(quantity('1'), now))
    const gone = unwrap(balance.ship(quantity('1'), now))

    // The machine a customer sends back in a year is the same machine — but it has only
    // just got here, so it queues behind the one that never left.
    unwrap(balance.takeBack(quantity('1'), later, gone))

    expect(held(balance)).toEqual(['SN-2', 'SN-1'])
  })
})
