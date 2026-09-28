import { describe, expect, it } from 'vitest'
import { filtersOf, isCurrent, queryOf, shownColumns } from './saved-views'

describe('saved views on the web', () => {
  it('writes filters as a stable query, without blanks, and reads them back', () => {
    const query = queryOf({ view: 'overdue', search: 'energia', role: null, empty: '' })
    expect(query).toBe('search=energia&view=overdue')
    expect(filtersOf(query)).toEqual({ search: 'energia', view: 'overdue' })
  })

  it('shows every column until a choice is made, and never none', () => {
    const all = ['counterparty', 'issuedOn', 'nextDue'] as const
    expect(shownColumns(all, null)).toEqual([...all])
    expect(shownColumns(all, ['nextDue', 'counterparty', 'gone'])).toEqual([
      'counterparty',
      'nextDue',
    ])
    expect(shownColumns(all, ['gone'])).toEqual([...all])
  })

  it('knows when the screen shows exactly a view', () => {
    expect(isCurrent({ query: 'a=1', columns: null }, 'a=1', null)).toBe(true)
    expect(isCurrent({ query: 'a=1', columns: ['x'] }, 'a=1', null)).toBe(false)
  })
})
