import { describe, expect, it } from 'vitest'
import { allowedActions, matches, nextIndex, paletteScreens } from './palette'

describe('the command palette', () => {
  it('offers only actions the roles allow', () => {
    const viewer = allowedActions([{ module: 'financial', role: 'viewer' }])
    const operator = allowedActions([{ module: 'financial', role: 'operator' }])
    expect(viewer).toEqual([])
    expect(operator.map((action) => action.id)).toEqual(['new-receivable', 'new-payable'])
  })

  it('offers only screens the roles show, the job centre to everyone', () => {
    const screens = paletteScreens([{ module: 'catalog', role: 'viewer' }], false).map(
      (entry) => entry.href,
    )
    expect(screens).toContain('/app/catalog/items')
    expect(screens).toContain('/app/jobs')
    expect(screens).not.toContain('/app/finance/payables')
  })

  it('matches every word, ignoring case and accents', () => {
    expect(matches('Contas a pagar', 'PAGAR contas')).toBe(true)
    expect(matches('Importações', 'importacoes')).toBe(true)
    expect(matches('Contas a pagar', 'receber')).toBe(false)
  })

  it('moves through the options with the keys, wrapping around', () => {
    expect(nextIndex(-1, 3, 'ArrowDown')).toBe(0)
    expect(nextIndex(2, 3, 'ArrowDown')).toBe(0)
    expect(nextIndex(0, 3, 'ArrowUp')).toBe(2)
    expect(nextIndex(1, 3, 'End')).toBe(2)
    expect(nextIndex(1, 3, 'Home')).toBe(0)
    expect(nextIndex(0, 0, 'ArrowDown')).toBe(-1)
  })
})
