import { describe, expect, it } from 'vitest'
import { formatOf, isOpen, selectedTotal } from './types'

describe('reconciliation workspace helpers', () => {
  it('adds up the open amounts of the selected rows only', () => {
    const rows = [
      { id: 'a', open: '-1000' },
      { id: 'b', open: '250' },
      { id: 'c', open: '-5' },
    ]
    expect(selectedTotal(rows, new Set(['a', 'b']))).toBe(-750n)
    expect(selectedTotal(rows, new Set())).toBe(0n)
  })

  it('offers only rows with something left to reconcile, and guesses the file format', () => {
    expect(isOpen({ status: 'partial' })).toBe(true)
    expect(isOpen({ status: 'ignored' })).toBe(false)
    expect(formatOf('Extrato.CSV')).toBe('csv')
    expect(formatOf('extrato.ofx')).toBe('ofx')
  })
})
