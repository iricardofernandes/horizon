import { describe, expect, it } from 'vitest'
import { MAX_STATEMENTS, moduleScreen, monthOf, resolveStatements } from './answers'

describe('statements and their sources (Phase 76)', () => {
  const known = new Set(['S1', 'S2'])

  it('keeps only sources that were read, and marks a statement left with none not found', () => {
    expect(
      resolveStatements(
        {
          statements: [
            { text: ' Dito. ', sources: ['S1', 'S1', 'S7', 3] },
            { text: 'Inventado.', sources: ['S9'] },
            { text: 'Sem lista.' },
          ],
        },
        known,
      ),
    ).toEqual([
      { text: 'Dito.', sources: ['S1'], found: true },
      { text: 'Inventado.', sources: [], found: false },
      { text: 'Sem lista.', sources: [], found: false },
    ])
  })

  it('drops what is not a statement, and keeps no more than the cap', () => {
    expect(resolveStatements(null, known)).toEqual([])
    expect(resolveStatements({ statements: [null, 3, { text: '' }] }, known)).toEqual([])
    const many = { statements: Array.from({ length: 40 }, () => ({ text: 'x', sources: ['S2'] })) }
    expect(resolveStatements(many, known)).toHaveLength(MAX_STATEMENTS)
  })

  it('counts the budget by calendar month, UTC', () => {
    expect(monthOf(new Date('2026-09-30T23:59:59Z'))).toBe('2026-09-01')
    expect(monthOf(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10-01')
  })

  it('links a record source to its module’s screen', () => {
    expect(moduleScreen('financial')).toBe('/app/finance/payables')
    expect(moduleScreen('unknown')).toBe('/app')
  })
})
