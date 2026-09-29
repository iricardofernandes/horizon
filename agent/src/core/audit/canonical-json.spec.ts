import { describe, expect, it } from 'vitest'
import { canonicalJson } from './canonical-json'

describe('canonical serialization', () => {
  it('sorts nested objects and treats omitted properties like undefined', () => {
    expect(canonicalJson({ z: { b: 2, a: 'quoted"' }, absent: undefined, a: true })).toBe(
      '{"a":true,"z":{"a":"quoted\\"","b":2}}',
    )
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2, absent: undefined }))
    expect(canonicalJson(Object.assign(Object.create(null), { b: 2, a: 1 }))).toBe('{"a":1,"b":2}')
  })
  it('represents money, dates, nulls and signed zero consistently', () => {
    expect(
      canonicalJson([
        1234567890123456789n,
        new Date('2026-09-10T12:00:00Z'),
        null,
        undefined,
        false,
        -0,
        1.5,
      ]),
    ).toBe('["1234567890123456789","2026-09-10T12:00:00.000Z",null,null,false,0,1.5]')
  })
  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    new Date('invalid'),
    new Map(),
    new Set(),
    Symbol('symbol'),
    () => {},
    undefined,
  ])('rejects ambiguous audit values: %s', (value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError)
  })
})
