import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { StockBalance } from './entities/stock-balance'
import { InventoryStockMovedEvent } from './events/inventory-events'
import { Currency, Money, Quantity } from './value-objects/inventory-values'
import type { MovementOrigin } from './value-objects/movement-origin'

const now = new Date('2026-09-20T09:00:00.000Z')

function unwrap<E, T>(result: { isLeft(): boolean; isRight(): boolean; value: E | T }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

const quantity = (value: string) => unwrap(Quantity.create(value))
const brl = unwrap(Currency.create('BRL'))
const money = (amount: string) => unwrap(Money.create(amount, brl))

const transfer = (): MovementOrigin => ({
  reason: 'transfer',
  document: { type: 'transfer', id: randomUUID() },
})

const fresh = () =>
  StockBalance.open({
    tenantId: randomUUID(),
    itemId: randomUUID(),
    warehouseId: randomUUID(),
    now,
  })

/** Every movement the balance has announced since it was last asked. */
function movements(balance: StockBalance) {
  return balance
    .pullDomainEvents()
    .filter((event): event is InventoryStockMovedEvent => event instanceof InventoryStockMovedEvent)
    .map((event) => event.movementOf())
}

describe('what a movement says a unit was then worth', () => {
  it('reports the average the goods were absorbed into, not the price they arrived at', () => {
    const balance = fresh()

    unwrap(balance.receive(quantity('10'), money('1000'), now))
    unwrap(balance.receive(quantity('10'), money('2000'), now))

    const [first, second] = movements(balance)
    expect(first?.unitCost?.amount).toBe(1000n)
    expect(first?.averageAfter?.amount).toBe(1000n)
    // Twenty units, ten bought at 10.00 and ten at 20.00, are worth 15.00 each.
    expect(second?.unitCost?.amount).toBe(2000n)
    expect(second?.averageAfter?.amount).toBe(1500n)
  })

  it('leaves a unit worth what it was when goods only leave', () => {
    const balance = fresh()
    unwrap(balance.receive(quantity('10'), money('1000'), now))
    unwrap(balance.receive(quantity('10'), money('2000'), now))

    unwrap(balance.transferOut(quantity('5'), transfer(), now))

    const last = movements(balance).at(-1)
    expect(last?.kind).toBe('transfer-out')
    expect(last?.averageAfter?.amount).toBe(1500n)
    expect(last?.balanceAfter.toString()).toBe('15')
  })

  it('says nothing about worth while the shelf has never been priced', () => {
    const balance = fresh()

    unwrap(balance.adjustIn(quantity('8'), null, transfer(), now))

    expect(movements(balance).at(-1)?.averageAfter).toBeNull()
  })

  it('still reports a worth when goods arrive at none onto a shelf that has one', () => {
    const balance = fresh()
    unwrap(balance.receive(quantity('10'), money('1000'), now))

    // The other half of a transfer out of a warehouse that never knew what it held.
    unwrap(balance.transferIn(quantity('5'), null, transfer(), now))

    const last = movements(balance).at(-1)
    expect(last?.unitCost).toBeNull()
    expect(last?.averageAfter?.amount).toBe(1000n)
  })

  it('carries the figure the balance itself ends on, movement after movement', () => {
    const balance = fresh()

    unwrap(balance.receive(quantity('3'), money('1000'), now))
    unwrap(balance.receive(quantity('3'), money('1100'), now))
    unwrap(balance.transferOut(quantity('1'), transfer(), now))
    unwrap(balance.receive(quantity('4'), money('900'), now))

    // Whatever the rounding did along the way, the last movement and the balance agree:
    // that is the whole claim the valuation report makes about the movement table.
    expect(movements(balance).at(-1)?.averageAfter?.amount).toBe(balance.unitCost()?.amount)
  })
})
