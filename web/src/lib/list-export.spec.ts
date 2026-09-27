import { describe, expect, it } from 'vitest'
import { fileNameOf, flatten, listQuery, neutralize, pageOf, toCsv } from './list-export'

describe('list exports', () => {
  it('keeps the list filter and drops what the exporter drives', () => {
    expect(
      listQuery(new URLSearchParams('status=open&limit=5&offset=10&locale=en')).toString(),
    ).toBe('status=open')
  })

  it('follows offset pages to their total, cursors, and bare arrays', () => {
    const query = new URLSearchParams('limit=2')
    expect(
      pageOf({ data: [1, 2], page: { limit: 2, offset: 0, total: 3 } }, query).next?.toString(),
    ).toBe('limit=2&offset=2')
    expect(
      pageOf({ data: [3], page: { total: 3 } }, new URLSearchParams('limit=2&offset=2')).next,
    ).toBeNull()
    expect(pageOf({ data: [1, 2], total: 2 }, query).next).toBeNull()
    expect(pageOf({ data: [1, 2] }, query).next?.get('offset')).toBe('2')
    expect(
      pageOf({ data: [1], page: { hasMore: true, nextCursor: 'abc' } }, query).next?.get('cursor'),
    ).toBe('abc')
    expect(pageOf({ data: [1], page: { hasMore: false } }, query).next).toBeNull()
    expect(pageOf([1, 2, 3], query)).toEqual({ rows: [1, 2, 3], next: null })
    expect(() => pageOf({ nope: true }, query)).toThrow()
  })

  it('flattens nested objects into dotted columns and keeps arrays as JSON', () => {
    expect(
      flatten({ id: 'a', total: { amount: '10', currency: 'BRL' }, tags: ['x'], note: null }),
    ).toEqual({ id: 'a', 'total.amount': '10', 'total.currency': 'BRL', tags: '["x"]', note: null })
    expect(flatten('bare')).toEqual({ value: 'bare' })
  })

  it('writes CSV with its metadata, neutralizing anything that could run', () => {
    expect(neutralize('=1+1')).toBe("'=1+1")
    const csv = toCsv({
      metadata: [['list', '/crm/accounts']],
      rows: [
        { name: '=HYPERLINK("x")', value: 1.5 },
        { name: 'Açaí; ok', other: true },
      ],
      locale: 'pt-BR',
    })
    expect(csv.slice(1).split('\r\n')).toEqual([
      'list;/crm/accounts',
      '',
      'name;value;other',
      `"'=HYPERLINK(""x"")";1,5;`,
      '"Açaí; ok";;true',
      '',
    ])
    expect(toCsv({ metadata: [], rows: [{ v: 2.5 }], locale: 'en' })).toContain('\r\n2.5\r\n')
    expect(fileNameOf(['crm', 'accounts'], new Date('2026-09-27T20:19:26Z'))).toBe(
      'crm-accounts-20260927-2019Z.csv',
    )
  })
})
