import { describe, expect, it } from 'vitest'
import {
  moneyOf,
  noteOf,
  quantityOf,
  serialsOf,
  unitsNamedOf,
  unitsPickedOf,
  worthOf,
} from './use-cases/inputs'

const value = <T>(result: { isLeft(): boolean; value: T }): T => {
  if (result.isLeft()) throw result.value
  return result.value
}

describe('what the edge of the system receives (ADR 0032)', () => {
  it('reads an absent note as none, and a present one as a note', () => {
    expect(value(noteOf(null))).toBeNull()
    expect(value(noteOf(undefined))).toBeNull()
    expect(value(noteOf('Conferido'))).not.toBeNull()
  })

  it('refuses money in a currency that does not exist', () => {
    expect(moneyOf('100', 'XX').isLeft()).toBe(true)
    expect(value(moneyOf('100', 'BRL')).amount).toBe(100n)
  })

  it('rounds what a quantity is worth half-up to the minor unit', () => {
    const cost = value(moneyOf('3', 'BRL'))
    expect(worthOf(value(quantityOf('0.5')), cost).amount).toBe(2n)
    expect(worthOf(value(quantityOf('0.1')), cost).amount).toBe(0n)
  })

  it('names nothing when the caller named nothing', () => {
    expect(value(unitsNamedOf({}))).toBeNull()
    expect(value(unitsPickedOf({ lots: null, serials: null }))).toBeNull()
    expect(value(serialsOf(undefined))).toBeNull()
  })

  it('reads lots with and without an expiry, and serial numbers', () => {
    const named = value(
      unitsNamedOf({
        lots: [
          { code: 'L-1', expiresOn: '2027-01-31', quantity: '2' },
          { code: 'L-2', quantity: '1' },
        ],
      }),
    )
    expect(named?.lots.map((lot) => lot.expiresOn === null)).toEqual([false, true])
    expect(value(unitsNamedOf({ serials: ['SN-1'] }))?.serials).toHaveLength(1)
    expect(value(unitsPickedOf({ lots: [{ code: 'L-1', quantity: '1' }] }))?.lots).toHaveLength(1)
  })

  it('refuses a bad lot code, quantity, expiry or serial number, naming where', () => {
    for (const bad of [
      { lots: [{ code: '', quantity: '1' }] },
      { lots: [{ code: 'L-1', quantity: 'x' }] },
      { lots: [{ code: 'L-1', expiresOn: '31/01/2027', quantity: '1' }] },
      { serials: [''] },
    ])
      expect(unitsNamedOf(bad, '/lines/0').isLeft()).toBe(true)
    for (const bad of [
      { lots: [{ code: '', quantity: '1' }] },
      { lots: [{ code: 'L-1', quantity: '-2' }] },
      { serials: [''] },
    ])
      expect(unitsPickedOf(bad).isLeft()).toBe(true)
  })
})
