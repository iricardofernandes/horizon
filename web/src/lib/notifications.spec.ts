import { describe, expect, it } from 'vitest'
import { majorUnits, paramsOf } from './notifications'

describe('notification messages', () => {
  it('fills blanks and renders amounts in major units', () => {
    const values = paramsOf({
      id: '1',
      kind: 'approval-payable',
      params: { titleId: 't-1', amount: '2500000', currency: 'BRL', note: null },
      link: null,
      createdAt: '',
      read: false,
    })
    expect(values).toEqual({ titleId: 't-1', amount: '25000.00', currency: 'BRL', note: '' })
    expect(majorUnits('5')).toBe('0.05')
    expect(majorUnits('-150')).toBe('-1.50')
    expect(majorUnits('abc')).toBe('abc')
  })
})
