import { describe, expect, it } from 'vitest'
import { EMPTY_COUNTS, finishedState, progressOf } from './import-job'
import {
  checkMapping,
  dateOf,
  decimalOf,
  listOf,
  normalizeHeader,
  recordOf,
  suggestMapping,
} from './import-values'

const fields = [
  { name: 'legalName', required: true, aliases: ['Razão Social', 'nome'], description: '' },
  { name: 'email', required: false, aliases: ['e-mail'], description: '' },
  { name: 'roles', required: false, aliases: [], description: '' },
]

describe('headers and mappings', () => {
  it('ignores case, accents, spaces and punctuation in a header', () => {
    expect(normalizeHeader(' Razão  Social ')).toBe('razaosocial')
    expect(normalizeHeader('E-mail')).toBe('email')
  })

  it('suggests each field the first column named after it or one of its aliases', () => {
    expect(suggestMapping(fields, ['RAZAO SOCIAL', 'E-Mail', 'Nome'])).toEqual({
      legalName: 'RAZAO SOCIAL',
      email: 'E-Mail',
      roles: null,
    })
  })

  it('accepts a complete mapping and fills the fields it leaves out', () => {
    const checked = checkMapping(fields, ['Nome', 'Mail'], { legalName: 'Nome' })
    expect(checked.isRight() && checked.value).toEqual({
      legalName: 'Nome',
      email: null,
      roles: null,
    })
  })

  it('refuses a missing required field, an unknown field and an unknown column', () => {
    expect(checkMapping(fields, ['Nome'], { email: 'Nome' }).isLeft()).toBe(true)
    expect(checkMapping(fields, ['Nome'], { legalName: 'Nome', color: 'Nome' }).isLeft()).toBe(true)
    expect(checkMapping(fields, ['Nome'], { legalName: 'Name' }).isLeft()).toBe(true)
  })

  it('reads a row as the fields, with blank cells absent', () => {
    expect(
      recordOf(['Nome', 'Mail'], { legalName: 'Nome', email: 'Mail', roles: null }, [
        ' Alfa ',
        '  ',
      ]),
    ).toEqual({ legalName: 'Alfa', email: null, roles: null })
  })
})

describe('values', () => {
  it('reads decimals the locale way', () => {
    expect(decimalOf('1.234,56', 'pt-BR')).toBe('1234.56')
    expect(decimalOf('-10', 'pt-BR')).toBe('-10')
    expect(decimalOf('1,234.56', 'en')).toBe('1234.56')
    expect(decimalOf('1 234,5', 'pt-BR')).toBe('1234.5')
    expect(decimalOf('abc', 'en')).toBeNull()
    expect(decimalOf('1.2.3', 'en')).toBeNull()
  })

  it('reads ISO dates, local dates and spreadsheet day numbers', () => {
    expect(dateOf('2026-09-28', 'en')).toBe('2026-09-28')
    expect(dateOf('28/09/2026', 'pt-BR')).toBe('2026-09-28')
    expect(dateOf('09/28/2026', 'en')).toBe('2026-09-28')
    expect(dateOf('46293', 'pt-BR')).toBe('2026-09-28')
    expect(dateOf('31/02/2026', 'pt-BR')).toBeNull()
    expect(dateOf('2026-13-01', 'en')).toBeNull()
    expect(dateOf('ontem', 'pt-BR')).toBeNull()
    expect(dateOf('9999999', 'en')).toBeNull()
  })

  it('splits a cell of several values on |', () => {
    expect(listOf('customer | supplier||')).toEqual(['customer', 'supplier'])
    expect(listOf(null)).toEqual([])
  })
})

describe('progress', () => {
  it('accounts for every row in exactly one bucket', () => {
    const counts = { ...EMPTY_COUNTS, valid: 3, invalid: 2, written: 4, rejected: 1 }
    expect(progressOf(counts, true)).toEqual({
      total: 10,
      valid: 8,
      written: 4,
      failed: 3,
      remaining: 3,
      cancelled: 0,
    })
    expect(progressOf({ ...EMPTY_COUNTS, pending: 5 }, false)).toMatchObject({
      valid: 0,
      remaining: 5,
    })
  })

  it('finishes only when no row remains, and completed only without failures', () => {
    expect(finishedState({ ...EMPTY_COUNTS, valid: 1, written: 2 })).toBeNull()
    expect(finishedState({ ...EMPTY_COUNTS, written: 2 })).toBe('completed')
    expect(finishedState({ ...EMPTY_COUNTS, written: 2, rejected: 1 })).toBe(
      'completed-with-failures',
    )
    expect(finishedState({ ...EMPTY_COUNTS, written: 2, invalid: 1 })).toBe(
      'completed-with-failures',
    )
  })
})
