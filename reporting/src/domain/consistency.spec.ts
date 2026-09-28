import { describe, expect, it } from 'vitest'
import { chainsCheck, compareAmounts, runOutcomeOf, totalsOf } from './consistency'

describe('consistency checks', () => {
  it('compares every currency either side names, a missing one counting as zero', () => {
    expect(compareAmounts('receivables-control', { BRL: '100' }, { BRL: '100' })).toMatchObject({
      outcome: 'matched',
      compared: 1,
    })
    expect(
      compareAmounts('payables-control', { BRL: '100' }, { BRL: '90', USD: '5' }).differences,
    ).toEqual([
      { key: 'BRL', owner: '100', ledger: '90' },
      { key: 'USD', owner: '0', ledger: '5' },
    ])
    expect(compareAmounts('cash-accounts', { BRL: '0' }, {}).outcome).toBe('matched')
  })

  it('sums pairs onto their keys', () => {
    expect(
      totalsOf([
        ['BRL', '10'],
        ['BRL', '-3'],
        ['USD', '1'],
      ]),
    ).toEqual({ BRL: '7', USD: '1' })
  })

  it('reads the audit chains as one check', () => {
    expect(
      chainsCheck([
        { module: 'ledger', status: 'intact', checked: 4, broken: [] },
        { module: 'treasury', status: 'broken', checked: 9, broken: [6, 7] },
        { module: 'files', status: 'unread', checked: 0, broken: [] },
      ]),
    ).toMatchObject({
      outcome: 'differences',
      compared: 2,
      differences: [{ key: 'treasury', owner: '9', ledger: '6' }],
    })
    expect(
      chainsCheck([{ module: 'files', status: 'unread', checked: 0, broken: [] }]).outcome,
    ).toBe('unread')
  })

  it('is inconsistent on any difference, and incomplete when something was not read', () => {
    const matched = compareAmounts('receivables-control', {}, {})
    const differing = compareAmounts('receivables-control', { BRL: '1' }, {})
    const silent = chainsCheck([{ module: 'files', status: 'unread', checked: 0, broken: [] }])
    expect(runOutcomeOf([matched])).toBe('consistent')
    expect(runOutcomeOf([matched, silent])).toBe('incomplete')
    expect(runOutcomeOf([silent, differing])).toBe('inconsistent')
  })
})
